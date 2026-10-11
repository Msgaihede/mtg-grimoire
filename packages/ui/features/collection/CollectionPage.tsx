import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Download,
  FolderInput,
  Lock,
  LockOpen,
  Trash2,
  Upload,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "@/components/Dialog";
import { UndoNotice } from "@/components/UndoNotice";
import type { MenuItem } from "@/components/menu/types";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { OwnedBadge } from "@/components/OwnedBadge";
import { QuantityStepper } from "@/components/QuantityStepper";
import { buildCardMenu, type CardMenuDeps, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { rowHasBackFace } from "@/features/card/printings";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { dragData } from "@/features/decks/dnd";
import { CONFIRM_CANCEL } from "@/features/decks/metaRows";
import { CardGrid, type GridSections } from "@/features/search/CardGrid";
import {
  FilterBar,
  StatedFiltersLine,
  type FilterLabels,
} from "@/features/search/FilterBar";
import { FilterQuickBar } from "@/features/search/FilterQuickBar";
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
import { collectionDestinationInto } from "@/features/transfer/import/destinations/CollectionPreview";
import { ImportExportPair } from "@/features/transfer/ImportExportPair";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { CONDITION_LABEL, CONDITIONS } from "@/lib/conditions";
import { count } from "@/lib/counts";
import { reorderedLevel } from "@/lib/folderOrder";
import { FINISH_LABEL, finishLabel, isFinish, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import {
  buildFolderTree,
  folderDescendants,
  folderLevel,
  trailOf,
} from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type CollectionFolder,
  type CollectionRow,
} from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { statusLine } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { layoutShelves, type ShelfSection } from "@/lib/shelfLayout";
import { UNFILED_SHELF, buildShelves, visibleShelves, type Shelf } from "@/lib/shelves";
import { useAppStore } from "@/lib/store";
import { tileKeyOf } from "@/lib/tileKey";
import { useDeskWidth } from "@/lib/useDeskWidth";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useDockHeight } from "@/lib/useDockHeight";
import { useFilterQuickBar } from "@/lib/useFilterQuickBar";
import { useReviewHandoff } from "@/lib/useReviewHandoff";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { CollectionBreadcrumb } from "./CollectionBreadcrumb";
import type { CollectionFolderTotals } from "./CollectionFolderCard";
import { CollectionSearchPanel } from "./CollectionSearchPanel";
import { CollectionSummaryHeader } from "./CollectionSummary";
import { CollectionTable, type CollectionTableShelves } from "./CollectionTable";
import {
  collectionTiles,
  NO_CARDS,
  shelfTotal,
  subtotalsOf,
  tilesByShelf,
  type CollectionTile,
} from "./collectionWall";
import {
  CollectionEmptyShelf,
  CollectionShelfHeading,
  CollectionShelfSticky,
  type CardTarget,
} from "./CollectionShelfParts";
import {
  NEW_FOLDER_SHELF,
  draftFolder,
  foldAll,
  foldChange,
  foldedForDrag,
  keepShelf,
  peekOf,
  rolledUp,
  shelfStat,
  treeParents,
} from "./collectionShelfModel";
import { EditCopy, type EditCopyTarget } from "./EditCopy";
import { collectionTileDragData, type CollectionCopy } from "./collectionDrag";
import { CollectionFolderPanel, LockedMoveConfirm, ROOT_LABEL } from "./CollectionFolderPanel";
import { PickCopies, type CopyChoice } from "./PickCopies";
import { ShareFolderMenu, shareTargetFor } from "./ShareFolderMenu";
import { pinnedFolders } from "./PinnedFolders";
import { COLLECTION_TRAY, useCollection, type Collection } from "./useCollection";
import { useCollectionDrops } from "./useCollectionDrops";
import { useCollectionEntryWrites } from "./useCollectionEntryWrites";
import { countEditableIn, quantityRefusal } from "./entryFences";
import {
  useCollectionFolders,
  useSetCollectionFolder,
  useSetCollectionFolderMany,
} from "./useCollectionFolders";

/**
 * The one dismissible layer this page can have open — the union, and never four flags.
 *
 * `DecksPage`'s `Panel` states the argument in full and it holds here for the same cabinet: a
 * half-typed folder name beside a half-answered delete question is not a state this view draws,
 * and separate booleans can express it. One value is also one Escape rung, which is the whole of
 * what {@link useDismissOnEscape} has to order.
 *
 * **No id lives in here that is not read.** `deleteFolder` carries its folder because — unlike
 * the gallery's, which asks about the folder the reader is *standing in* — this question is asked
 * about a folder's **heading**, anywhere on the wall under where the
 * reader is standing, and there is nothing else on the page holding which one.
 *
 * **`editCopy` is the first member that is not about the cabinet**, and it is in here rather than
 * beside it as a fifth boolean for the union's own argument: a half-typed folder name under an
 * open copy editor is not a state this view draws either, and one value is one thing to reason
 * about. What it is *not* is a second Escape rung — that layer is a `Dialog`, and every `Dialog`
 * registers its own `"inner"` rung on its open flag. See {@link CollectionPage.openPanel}, which
 * is where the folder half of this union parts company with this member.
 *
 * **`clearRemoved` carries no id, and that is `deleteFolder`'s rule read the other way** (issue
 * #506): it is asked only while the reader is *standing in* `Recently removed`, there is exactly
 * one such folder, and the pinned census already names it — so an id here would be a second copy
 * of a fact the page holds, free to disagree with it.
 *
 * **`removeCopies` carries the entries, and is the second member that is not about the cabinet**
 * (issue #555): `Remove N cards from collection…` over more than one entry asks before it writes,
 * in the strip `clearRemoved` is asked in and on its terms — the same landing pad, the same
 * Escape rung, the same blur. The ids are held rather than re-derived because the question is
 * about the rows the menu reached, and nothing else on the page remembers which those were.
 */
type Panel =
  | { kind: "newFolder"; parentId: number | null; originShelfId?: number }
  | { kind: "renameFolder"; folderId: number }
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | { kind: "clearRemoved" }
  | { kind: "removeCopies"; entryIds: readonly number[] }
  | { kind: "editCopy"; entryId: number }
  | null;

/**
 * The finish this tile is **marked** with — the tile's own word, with `nonfoil` mapped to nothing.
 *
 * **`nonfoil` is not a mark, and that is a rule with a shipped failure behind it.** `CardArt` gates
 * its whole top-right chip on `finish !== null` while `FinishMark` early-returns for a plain copy,
 * so handing the word straight through paints the `bg-bg/85` felt with nothing inside it — an
 * empty rectangle over the art, on most tiles of most collections. `soleFinish` maps it to `null`
 * and `DeckFinish` excludes it outright; this is that convention on the one wall whose rows can
 * actually carry the word.
 *
 * **It is a function rather than an expression written twice because two things read it now**: the
 * chip over the art, and the accessible name of the stepper drawn in the same corner of the same
 * tile. A tile that drew no sheen while its stepper announced "(Nonfoil)" would be one fact
 * answered two ways six pixels apart — the class of drift this file already fixed once for the
 * chip itself. Module scope so `CardGrid`'s `finish` slot can be handed it directly rather than a
 * fresh arrow per render, which is what that prop asks for.
 *
 * A `null` `tile.finish` is a word this build cannot name (see {@link CollectionTile.finish}) and
 * stays `null` here: marking the art with a sheen no stylesheet has, or announcing a word the
 * reader's own row spells and this build does not, are the same mistake.
 */
function finishMarkOf(tile: CollectionTile): Finish | null {
  return tile.finish === "nonfoil" ? null : tile.finish;
}

/**
 * Whether this tile's copies are in a drawer the reader has set aside (issue #436).
 *
 * One folder per tile since shelves (decision 11), so this is that folder's **effective** lock —
 * `lockedIds`, never a folder's own `locked` flag, because the lock inherits down the tree. The
 * heading above the tile wears the same lock; the tile wears it too because a shelf of forty cards
 * scrolls its heading off screen long before its last row, and the sticky bar names the shelf
 * without its figures.
 */
function tileLocked(tile: CollectionTile, lockedIds: ReadonlySet<number>): boolean {
  return tile.folderId !== null && lockedIds.has(tile.folderId);
}

/**
 * The chin's printing line — `CardGrid`'s own `SET · number`, with a `Lock` after it on a tile whose
 * drawer is set aside.
 *
 * **The words are the wall's own default, restated because the slot is the whole of that line**:
 * `caption` replaces the text rather than appending to it, and an unlocked tile must read exactly
 * as it would with no slot at all. `role="img"` named `Locked`, the heading's and `ElsewhereMark`'s
 * arrangement, so the fact survives being read rather than seen.
 *
 * **The line must stay one line** — `CardGrid` positions its rows from `CAPTION_HEIGHT`, a budget
 * rather than a minimum — so the printing truncates and the glyph is `shrink-0` beside it.
 */
const lockedCaption = (lockedIds: ReadonlySet<number>) => (tile: CollectionTile) => {
  const printing = `${tile.setCode.toUpperCase()} · ${tile.collectorNumber}`;
  if (!tileLocked(tile, lockedIds)) return printing;
  return (
    <span className="flex min-w-0 items-center gap-[calc(0.375rem*var(--mark-scale,1))]">
      <span className="min-w-0 truncate">{printing}</span>
      <Lock
        role="img"
        aria-label="Locked"
        className="size-[calc(0.75rem*var(--mark-scale,1))] shrink-0 text-dim"
      />
    </span>
  );
};

/**
 * The card a right-click on an **entry** is about.
 *
 * **A collection row is a finish** — it is one of the ten columns the row's identity is made
 * of — so the menu names it rather than asking. The `isFinish` guard is not ceremony:
 * `collection_entries.finish` is TEXT with a CHECK rather than an enum this side knows, so a
 * row can spell something this build has never heard of, and an unrecognised word must not
 * arrive at the backend as a finish.
 *
 * **`oracleId` travels straight through, with no fallback**, and that is what makes the menu's
 * one greyed row honest here. It comes off the same `LEFT JOIN` as `name` and `rarity`, so a
 * `null` means the entry's printing has left the corpus — 0 of 116 590 live rows have a null
 * `oracle_id` — which is exactly what "View all printings" says when it greys itself out. Every
 * healthy row gets a live item. (This adapter passed a hardcoded `null` until
 * `CollectionRow.oracleId` landed, which greyed the row on the reader's whole collection and
 * gave a true sentence about a card that was fine.)
 *
 * `finishes` is `null` because a collection row genuinely has no such list: it says which finish
 * the reader *holds*, never which ones the printing exists in. The wall's tile can do better —
 * see {@link tileTarget}.
 *
 * **`entryId` is what unlocks `Move to → folder`, and it is the one field only this adapter can
 * fill.** The menu offers that row where — and only where — the target names a row of
 * `collection_entries`, because moving a copy between drawers is `collection_set_folder(id, …)`
 * and there is nothing else to address it by. A right-click on a *tile* or on a search result is
 * about a card the reader may not own at all, so {@link tileTarget} deliberately leaves it out
 * rather than inventing one from the entries behind the art — a tile merges every entry for that
 * printing **in that finish**, across grades, languages and folders, and picking one of them to
 * move would be the app choosing which copy the reader meant.
 */
function rowTarget(row: CollectionRow): CardMenuTarget {
  return {
    cardId: row.cardId,
    entryId: row.id,
    // An orphaned entry has no name — `cards` does not know this printing any more — and the
    // set and number beside it are the entry's own columns, copied at write time for exactly
    // this. The same fallback the wall's tiles use.
    name: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    oracleId: row.oracleId,
    finishes: null,
    finish: isFinish(row.finish) ? row.finish : undefined,
    typeLine: row.typeLine,
  };
}

/**
 * The card a right-click on a **tile** is about.
 *
 * Where {@link rowTarget} *names* a finish, this one offers a **list** — and since the finish
 * joined the wall's grain that list holds exactly one entry, so the two are now the same rule
 * arriving at the same answer by different roads: a row is one entry and therefore one finish,
 * and a tile merges only the entries that agree about their finish. So the tile hands over the
 * finishes its own entries are in ({@link ownedFinishes}) and the menu records that one without
 * asking, through the very same component the search wall uses.
 *
 * The list is the reader's *holdings* rather than the printing's catalogue, which is the only
 * honest list a collection row can produce and is also the better one here — an add from this
 * wall is a copy of something already in the binder.
 */
/**
 * A stored grade as the app spells it, or the raw column where it is not one of the five.
 *
 * **A loop rather than a cast**, which is the only way to narrow a `string` onto
 * `CONDITION_LABEL`'s keys without asserting something the column does not guarantee: the
 * database holds text, and a row written by an import or by an older build may carry a word this
 * build has never heard of. `lib/finish.ts` publishes an `isFinish` guard for its own column and
 * `lib/conditions.ts` publishes none, so the narrowing is done here rather than by widening that
 * module for one caller.
 */
function conditionLabel(raw: string): string {
  for (const condition of CONDITIONS) if (condition === raw) return CONDITION_LABEL[condition];
  return raw;
}

function tileTarget(tile: CollectionTile, entryIds: readonly number[] = []): CardMenuTarget {
  return {
    cardId: tile.id,
    // **The rows behind the art, where a table row names its one `entryId`.** This is what
    // unlocks `Move to` on a wall tile, and it is a *list* rather than a chosen id for the
    // reason the paragraph above gives: picking one of them would be the app deciding which
    // copy the reader meant. `moveItem` asks which when there is more than one.
    entryIds,
    name: tile.name,
    setCode: tile.setCode,
    collectorNumber: tile.collectorNumber,
    oracleId: tile.oracleId,
    finishes: tile.finishes,
    typeLine: tile.typeLine,
  };
}

/**
 * The collection: what it adds up to, what is in it, and the quantities editable in place.
 *
 * The aggregate header is the one composition this view adds to the app, and it is data —
 * so it is the mono face, unemphasised, with no colour and no chrome. Everything loud on
 * this screen is card art, exactly as it is in search.
 */
/**
 * What this surface calls its search box, and the `id` stem its labels bind through.
 *
 * **`Search your collection` and never the search page's `Search cards`**, which is `FilterLabels`'
 * whole reason: this box narrows the reader's own binder and that one narrows every printing
 * Scryfall has published, so one name over both would be the control lying about which list it is
 * over — and a `getByLabelText` could not tell the two apart.
 */
const COLLECTION_LABELS: FilterLabels = {
  idStem: "collection",
  search: "Search your collection",
};

/**
 * The width the collection's own list must keep, in px — **`DeckEditor`'s `DECK_FLOOR` read across
 * to a page that draws two things rather than one**, and the number the docked search column is
 * railed by.
 *
 * The deck's floor is 192 because that is one stack column. This page's list was a *pair* of walls
 * stacked vertically until folder shelves (2026-09-26) — the cabinet's folder cards above, each
 * cell `minmax(180px, 1fr)`, and the card grid or table below — and 192 held a folder cell with the
 * page's own padding off it. The shelved wall is one wall now and its headings fill whatever width
 * the wall has, so what 192 has to hold is a column of tiles, and it does: a wall too narrow for a
 * whole 170px tile draws it at the wall's own width instead (`CardGrid`'s `tileWidthFor`), so the
 * column narrows rather than overflowing. That is why the deck's number is reused rather than a
 * second one invented.
 *
 * **Measured in the shipped window on 2026-09-07** (`pnpm tauri dev`, a debug build, against a
 * real 276-copy collection), and the measurement split it in two: **the floor is the *view's*, not
 * the page's.**
 *
 * The card wall really does hold at 192 — driven at viewport widths of 1264, 1008, 884 and 784 the
 * wall's `scrollWidth` never exceeded its `clientWidth` and it went on drawing tiles all the way
 * down. So {@link CARD_FLOOR} is the paragraph above, confirmed.
 *
 * **The table does not, and it fails at a window nobody would call narrow.** `CollectionTable`'s
 * five fixed columns measure 464px and its gaps and padding another ~101, so the name column is
 * `list − 565` — checked at three widths and linear: a 936px list gives it 371, 736 gives 171,
 * and **616 gives 51**. 616 is what this page's list gets at the app's own 1280×800 reference
 * window with the panel at its opening width, so the shipped default put a reader's card names in
 * a 51px column. Below a 486px list the name column is *gone* and the table scrolls sideways
 * inside its own root — no page-wide scrollbar, because `min-w-0` holds, which is exactly why
 * neither suite nor a screenshot of the whole window would ever have caught it.
 *
 * {@link TABLE_FLOOR} is therefore 565 plus a name column worth having. 115px shows
 * "Ancient Tomb" and truncates a long one, which is what the column does at every width anyway.
 *
 * **Not folded into one number for both views.** A single floor at the table's figure would push
 * the panel to its overlay at 1024 on the *card* view, where a 360px list was measured drawing
 * four tiles with no overflow at all — a working layout refused because a different view could
 * not have used it.
 */
const CARD_FLOOR = 192;
const TABLE_FLOOR = 680;

/** What a shelf with nothing loaded hands `CardGrid` and the table — one array, so an empty
 *  shelf's answer is the same object every render. */
const NO_TILES: readonly CollectionTile[] = [];
const NO_ROWS: readonly CollectionRow[] = [];

/**
 * **The wall, memoised** (issue #557). `CardGrid` is the search page's component and draws every
 * tile it is handed on every render it gets, so a keystroke in this page's filter box — state on
 * the page, and a render of the whole page before the debounce has asked anything — drew every tile
 * on the wall again. Behind `memo`, and handed only props that hold still across a render that
 * changes no data, the wall is not rendered at all by such a keystroke. The cast keeps `CardGrid`'s
 * generic signature, which `memo` would otherwise erase.
 */
const CollectionCardGrid = memo(CardGrid) as typeof CardGrid;

/** The owned-copies badge in a tile's corner — module scope so the memoised wall is handed one
 *  function for its whole life rather than a fresh arrow per render. The argument is at its slot. */
function ownedBadgeOf(tile: CollectionTile) {
  return <OwnedBadge owned={tile.copies} />;
}

/** The element holding the caret, or `null` — what a callback with no event hands {@link open}. */
function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}


export function CollectionPage() {
  // The To review widget's needs-review hand-off — `useReviewHandoff` has the whole rule.
  const review = useReviewHandoff("collection");
  const collection = useCollection({ initialNeedsReview: review.initialNeedsReview });
  review.settle(collection.needsReview, collection.setNeedsReview);
  // `folderId` is the level **on screen**, which trails `requestedFolderId` by a round trip while a
  // level nothing has cached arrives (`useCollection`'s `shown`). Everything drawn reads the
  // first; the page's navigation — the two hand-offs below and Escape's step up — reads the second.
  const { query, figures, rows, total, marketplace, folderId, requestedFolderId } = collection;
  const view = useAppStore((s) => s.collectionView);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  /**
   * The wall's own opener, and the finish it last opened the pane as.
   *
   * **Not `setSelectedCardId`**, which is every other surface's and clears `paneFinish` in the
   * same write: a tile here is a printing *and* a finish, so a press has something to say that
   * the plain opener structurally cannot carry. The pane seeds its foil view from it — there is
   * no foil photograph to fetch, so what it turns on is `FoilOverlay` over the same picture.
   *
   * **This page holds no other opener, and that is a deletion rather than an omission.**
   * `setSelectedCardId` was read here for the wall's `onSelect` and for nothing else — the table
   * beside it opens no card, its rows offering a stepper, a removal and a menu — so leaving the
   * plain opener in scope would be a second way to open a card from this page that nothing
   * presses and that would silently drop the finish if anything ever did.
   */
  const openCardAsFinish = useAppStore((s) => s.openCardAsFinish);
  const paneFinish = useAppStore((s) => s.paneFinish);
  const folders = useCollectionFolders();
  // The folder writes' `mutate` and `reset`, which hold still across renders where the mutation
  // objects around them are new every time (issue #557). Every heading callback below is built from
  // these rather than from the objects, so the wall and the table — both memoised — are handed the
  // same drawings until something drawn on them changed. The `isPending` flags are read off the
  // objects where they are drawn.
  const { mutate: createMutate, reset: createReset } = folders.create;
  const { mutate: renameMutate, reset: renameReset } = folders.rename;
  const { mutate: moveMutate, reset: moveReset } = folders.move;
  const { mutate: reorderMutate } = folders.reorder;
  const { mutate: removeFolderMutate, reset: removeFolderReset } = folders.remove;
  const { mutate: setLockedMutate, reset: setLockedReset } = folders.setLocked;

  /**
   * **The folder another surface asked this page to open on its way in** — `store.ts`'s
   * `pendingFolder`, whose only writer today is the home page's folder shortcuts.
   *
   * Read here rather than in {@link useCollection} because the question a hand-off has to answer
   * is *is that drawer still there*, and the census that knows is this page's — the hook holds
   * only where the reader is standing.
   *
   * **A render-phase adjustment rather than a mount effect, and both halves of that are
   * deliberate.** React's own answer to "state that has to follow something upstream" is to make
   * the change while rendering: React throws this render away and restarts it before committing,
   * so the drawer is on screen in one pass with no flash of the root — `DecksPage` opens the
   * folder a returning deck is filed in exactly this way. It is also the only shape available:
   * `setFolderId` called from inside a `useEffect` body is a lint failure (cascading renders),
   * which this project has paid for twice. And reading it *as it renders* rather than only as it
   * mounts is what makes the widget's two store writes safe to land in either one commit or two.
   *
   * **It waits for the census** — `is that folder still there` cannot be asked of a list that has
   * not answered — and once the list is in, a hand-off naming a folder this cabinet no longer
   * carries is dropped in **silence**: a drawer another surface deleted between the press and the
   * arrival is a race rather than an error, and the root is where its cards have just gone. The
   * effect below spends the hand-off either way, so a folder that is gone cannot leave one
   * pending forever.
   *
   * **And it is spent, which is the whole of what "one-shot" means.** A hand-off that survived
   * its read would drop the reader back into that drawer the next time they opened this page,
   * which is the folder-restored-at-launch behaviour `useCollection` refuses in words.
   */
  const pendingFolder = useAppStore((s) => s.pendingFolder);
  const clearPendingFolder = useAppStore((s) => s.clearPendingFolder);
  const pendingHere =
    pendingFolder !== null && pendingFolder.scope === "collection" && !folders.query.isPending
      ? pendingFolder.id
      : null;
  // Against the level asked for, never the one on screen: that one trails a render-phase write
  // by a round trip, so comparing with it would write the same level again every pass until React
  // gave up.
  if (pendingHere !== null && requestedFolderId !== pendingHere) {
    if (folders.folders.some((folder) => folder.id === pendingHere)) {
      collection.openFolder(pendingHere);
    }
  }
  useEffect(() => {
    if (pendingHere !== null) clearPendingFolder();
  }, [pendingHere, clearPendingFolder]);
  /**
   * **A review hand-off opens the root**, which is the whole cabinet on shelves — To review counted
   * the flagged copies in every drawer, and a folder's wall holds only its own subtree. A page
   * freshly mounted is at the root already (`folderId` is `useState`, never restored), so this acts
   * only when the hand-off lands on a page standing in a folder. `initialNeedsReview` is `true`
   * exactly while a hand-off naming this page is waiting, and `requestedFolderId !== null` is what
   * makes the render-phase write terminate — the level asked for, for the reason one block up.
   * **A named drawer outranks it** (`pendingHere === null`): no surface posts both, but two
   * render-phase writes aimed at two levels would chase each other until React gave up, so the pair
   * is ordered rather than trusted.
   */
  if (review.initialNeedsReview && pendingHere === null && requestedFolderId !== null) {
    collection.openFolder(null);
  }

  /**
   * **A level deleted elsewhere is walked out of** (the final review's C-M4) — another window or a
   * synced device deletes the drawer this page stands in. `buildShelves` answers no shelves for a
   * level that no longer exists, so the reader was left on an empty wall under a breadcrumb with
   * nothing to press, and only Escape could get them out. Once the folder list has answered without
   * the level, the page opens **its nearest surviving ancestor**, or the root if none survives.
   *
   * The ancestors are the ones the level last had: a deleted folder's `parent_id` goes with it, so
   * the trail is remembered while the level is there (`levelTrail`) and read back once it is not.
   * Both writes are render-phase adjustments — the `pendingFolder` block's arrangement — and both
   * terminate: the trail is written only when it changed, and the walk moves the level asked for to
   * one the list does carry, or to the root. **A hand-off waiting for this page outranks it**, the
   * pair above's ordering, so two render-phase writes can never chase each other.
   */
  const [levelTrail, setLevelTrail] = useState<{
    level: number;
    ids: readonly number[];
  } | null>(null);
  if (requestedFolderId !== null && !folders.query.isPending && pendingHere === null) {
    if (folders.folders.some((folder) => folder.id === requestedFolderId)) {
      const ids = trailOf(folders.folders, requestedFolderId).map((folder) => folder.id);
      if (levelTrail?.level !== requestedFolderId || !sameIds(levelTrail.ids, ids)) {
        setLevelTrail({ level: requestedFolderId, ids });
      }
    } else {
      const known = levelTrail?.level === requestedFolderId ? levelTrail.ids : [];
      const survivor = known
        .filter((id) => id !== requestedFolderId)
        .reverse()
        .find((id) => folders.folders.some((folder) => folder.id === id));
      collection.openFolder(survivor ?? null);
    }
  }

  /**
   * Which folder layer is open, and what the caret goes back to when it closes.
   *
   * **The opener is a ref rather than a piece of `Panel`** for the reason `DecksPage` gives: the
   * triggers here are controls of one wall — the path row's Add folder, and every heading's Add
   * folder, Rename and `⋯` — so capturing the element when the layer opens is the only way one
   * handler can serve a wall of them.
   */
  const [panel, setPanel] = useState<Panel>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  /**
   * The row the list and the docked search column share, and the box the column is pinned inside
   * — `DeckEditor`'s desk and dock, on a page that had neither because it was `flex-col` from its
   * root down.
   *
   * The desk is the only width the panel can honestly be judged against: the window's own is the
   * sidebar, the page padding and this page's own gutters away from it.
   */
  const deskRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  /**
   * **The filter quick bar** (spec 2026-09-29): a one-row copy of the page's filters that docks at
   * the top of `main` once the page's own `FilterBar` block has scrolled out of view, so a reader
   * forty shelves down can narrow the wall without scrolling back up to do it.
   *
   * `filterRow` is **state, not a ref**, and that is what makes it work: it is handed to
   * `FilterBar` as a callback ref (`rootRef`), and `useFilterQuickBar` builds its
   * `IntersectionObserver` over whatever element it is given — a `RefObject` notifies nobody, so a
   * block that mounted after the first commit (or remounted) would never be observed at all.
   *
   * **Grid only.** The table view pins this section to `main`'s height (`h-full` below) and
   * `VirtualTable` is its own scroller, so the filter row never leaves the screen there and asking
   * would draw a bar over a page whose row is still in plain sight. Disabled, the hook answers
   * hidden with no clearance, which is also what jsdom answers — its stub observer never fires.
   *
   * Declared here, beside `dockRef`, because two later sites read it before the JSX does: the
   * dock's height below (`quick.dockTop`) and the wall's `renderSticky` (`quick.shown`).
   */
  const [filterRow, setFilterRow] = useState<HTMLDivElement | null>(null);
  const quick = useFilterQuickBar(filterRow, view === "grid");
  /**
   * What that row can spare for the column: the widest the panel may be drawn or dragged, whether
   * the list and the column fit **beside** each other, and — when they do not — how wide to draw
   * the panel **over** the list.
   *
   * `useDeskWidth` carries the whole of it, including the observer, why the viewport is
   * `documentElement.clientWidth` rather than `window.innerWidth`, and why an unmeasured row reads
   * as roomy. **It was this file's own block until it was the wishlist's too**, byte for byte,
   * which is N decisions that happen to agree rather than one.
   *
   * **The floor is handed in rather than assumed by the hook**, because it is a fact about this
   * page's list and not about docked columns — and since 2026-09-07 it is a fact about the *view*
   * rather than the page: {@link CARD_FLOOR} against {@link TABLE_FLOOR} carries the measurement
   * and why one number for both would refuse a layout the card wall was measured working in.
   *
   * **Switching view therefore re-clamps the panel but never overwrites the reader's width**, which
   * is `CardSearchPanel`'s standing rule read from a new direction: the caps clamp what is *drawn*
   * and a drag clamps what is *stored*, so a reader who opens the table, loses 100px of panel to
   * it, and goes back to the cards gets their own width back rather than the squeeze.
   *
   * What comes back carries no "unless a card is open" term either, unlike the deck editor's: the
   * card surface is a centred modal on every page since 2026-09-03 and takes width from nothing.
   */
  const { maxPanelWidth, roomy, overWidth } = useDeskWidth(
    deskRef,
    view === "table" ? TABLE_FLOOR : CARD_FLOOR,
  );

  /**
   * The dock's height — **arithmetic rather than a length**, because CSS cannot say "the
   * scroller's visible height, less however much of the page sits above this row".
   *
   * `sticky` on the dock (at `quick.dockTop`) does the pinning and this does only the height. The
   * hook finds the scroller itself, which is what lets one hook serve this page (scrolling in
   * `AppShell`'s `main`) and the deck editor (an `overflow-y-auto` section of its own) without
   * either site knowing which. `useDockHeight` carries the whole of it, including why it re-checks
   * its wiring after every commit.
   *
   * **`quick.dockTop` is the third argument, and the dock's own `top` is the same number** — 41px
   * while the filter quick bar is down (the bar's 53px, less `main`'s 20px padding the sticky
   * already sits inside, plus the deck bar's 8px of clearance), 0 while it is up. The height is the
   * scrollport *below the inset*, so a height measured against 0 under a dock pinned at 41 would
   * run its foot 41px past the bottom of `main`, and the panel's last rows would be unreachable.
   * Handing the hook the inset is also what re-measures on the flip: the bar coming down moves the
   * dock without resizing either observed box and without a scroll having to follow, which is
   * exactly the case the hook's `top` exists for (the deck editor's issue #577, the same shape).
   */
  useDockHeight(dockRef, deskRef, quick.dockTop);

  /**
   * The export dialog, and the sweep that fills it — see `scope.ts`'s doc for why the sweep
   * exists at all rather than exporting the page already in memory.
   *
   * `useExportScope` runs on every render, `enabled` or not: `ExportDialog` is mounted
   * unconditionally below (the same shape `DeckEditor`'s is), so that closing it fades the
   * shell out instead of yanking it out of the tree — and that means this hook has to be
   * called every render too, `enabled: exporting` is what stops it from sweeping the whole
   * collection on every filter keystroke nobody asked to export.
   */
  const [exporting, setExporting] = useState(false);
  const [exportFolder, setExportFolder] = useState<CollectionFolder | null>(null);
  const collectionExportScope = useExportScope(
    "collection",
    collection.filters,
    exporting && exportFolder === null,
  );
  // A folder-options press names a whole drawer, independently of the wall's filters and
  // collapsed shelves. Keep its sweep separate so a previous "everything" choice cannot
  // turn this export into the whole collection. Shelves also include locked descendants.
  const folderExportScope = useExportScope(
    "collection",
    {
      shelves: exportFolder
        ? [exportFolder.id, ...folderDescendants(folders.folders, exportFolder.id)]
        : [],
      marketplace: collection.filters.marketplace,
    },
    exporting && exportFolder !== null,
  );
  const exportScope = exportFolder === null ? collectionExportScope : folderExportScope;

  /**
   * The import dialog, and the folder its `Import into` opens on (issue #872) — `null` while it is
   * shut. One destination, so no radio group is drawn — a choice between one thing is not a
   * choice.
   *
   * **Which folder is the entry point's to say.** The header's `Import cards` opens on the drawer
   * the reader is standing in, or on Not sorted at the root or inside a shelf the app owns; a
   * folder menu's `Import…` opens on that folder, and hands the caret back to its `⋯` on the way
   * out, which is the menu's `Export…` rule.
   */
  const [importing, setImporting] = useState<{
    folderId: number | null;
    fromMenu: boolean;
  } | null>(null);
  const importFolderId = importing?.folderId ?? null;
  // Keyed on the folder alone: what comes back is a component identity, and a fresh one would
  // remount the step under the reader (`collectionDestinationInto`'s rule).
  const importDestinations = useMemo(
    () => [collectionDestinationInto({ folderId: importFolderId })],
    [importFolderId],
  );
  const closeImport = (refocus: boolean) => {
    if (refocus && importing?.fromMenu === true) openerRef.current?.focus();
    setImporting(null);
  };

  /**
   * The entry writes — the stepper, the removal and the bulk removal — and the cache arithmetic
   * they share. **`useCollectionEntryWrites` since 2026-10-03**, store-free, so the light app's
   * phone face presses the same three mutations with the same patches and invalidations; the
   * doc for each is at its new home.
   */
  const { settleFailure, setQuantity, remove, removeMany } = useCollectionEntryWrites();
  // `mutate` and `reset` are stable across renders and the result object around them is not, so
  // the menu deps below are rebuilt only when something they carry actually changed — and, since
  // issue #557, so are the stepper and removal handlers the memoised wall and table are handed.
  const { mutate: removeManyMutate, reset: removeManyReset } = removeMany;
  const { mutate: setQuantityMutate } = setQuantity;
  const { mutate: removeMutate } = remove;

  /**
   * `Clear…` inside `Recently removed` — every copy in the holding area, gone in one transaction
   * (issue #506).
   *
   * **The whole view is re-read, success or refusal**, because this is not one row changing: it is
   * a folder's worth of rows leaving at once, so there is nothing to patch and the list has to be
   * asked again. The four keys are {@link settleFailure}'s, and for its reasons — the list, the
   * header and the folder subtotals under `["collection"]`, every wish's `ownedQuantity`, the
   * search's owned badges, and every deck's theory lists, which count spare copies wherever they
   * sit. A refusal (`NO_REMOVED_FOLDER`, the folder gone under another window) takes the same
   * refresh, which is what makes the pinned entry disappear rather than go on offering a clear.
   */
  const clearRemoved = useMutation({
    mutationFn: () => ipc.collectionRemovedClear(),
    onSettled: settleFailure,
  });
  const { mutate: clearRemovedMutate } = clearRemoved;

  /**
   * Filing a copy — the drag's write, and **the same mutation the row's own context menu makes it
   * through**, so a merge behaves the same whichever hand made the gesture.
   *
   * The command, the settle set and the reason none of it is optimistic all live on
   * {@link useSetCollectionFolder}; this page adds only its refusal surface, which is the banner
   * under the header that every other write here shares (`bannerFailure` below). The menu's copy
   * of this hook draws `CardMenuRefusal` instead, because a menu is already closing by the time
   * the answer arrives and has nothing left on screen to report to — that difference is the whole
   * of what the two callers do differently, and it is why the hook takes handlers rather than
   * owning one.
   *
   * This page's sentence was that there was one mutation while there were two of them. There is
   * one now.
   */
  const setFolder = useSetCollectionFolder();
  /**
   * The same filing over several entries in **one** write (issue #555) — what the copy picker's
   * answer makes when the reader ticked more than one. It was `setFolder` once per tick: N
   * transactions and N feed lines, and a refusal part-way filed half the copies. The hook makes
   * the undo offer itself, so this page and the card menu cannot differ about it; the refusal
   * shares this page's banner with every other write here.
   */
  const setFolderMany = useSetCollectionFolderMany();
  // Held still for the drops below, `removeMany`'s reason.
  const { mutate: setFolderMutate } = setFolder;

  const onSetQuantity = useCallback(
    (row: CollectionRow, quantity: number) => setQuantityMutate({ row, quantity }),
    [setQuantityMutate],
  );
  const onRemove = useCallback((row: CollectionRow) => removeMutate(row), [removeMutate]);
  // Not while the previous level is still drawn (`levelHeld`): the rows the wall is asking to page
  // past are that level's, and `query` is already the next level's list.
  const { levelHeld } = collection;
  // The four fields rather than `query`, which is a new object on every render (issue #557): the
  // memoised wall and table are both handed this, and keyed on `query` it was new on every
  // keystroke. `fetchNextPage` is the observer's own bound method and holds still.
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  const onNeedNextPage = useCallback(() => {
    if (!levelHeld && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [levelHeld, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  /** The wall's tiles — `collectionWall.ts`'s {@link collectionTiles}, where the folding rule is
   *  argued: the card, the finish and the folder make a tile; the grade and the language do not. */
  const tiles = useMemo(() => collectionTiles(rows), [rows]);

  /** The tiles **by shelf** — {@link tilesByShelf}; the rows by shelf beside it are the table's. */
  const tilesOnShelves = useMemo(() => tilesByShelf(tiles), [tiles]);
  const tilesOf = useCallback(
    (shelfId: number): readonly CollectionTile[] => tilesOnShelves.get(shelfId) ?? NO_TILES,
    [tilesOnShelves],
  );
  const rowsByShelf = useMemo(() => {
    const out = new Map<number, CollectionRow[]>();
    for (const row of rows) {
      const shelf = row.folderId ?? UNFILED_SHELF;
      const held = out.get(shelf) ?? [];
      held.push(row);
      out.set(shelf, held);
    }
    return out;
  }, [rows]);
  const rowsOf = useCallback(
    (shelfId: number): readonly CollectionRow[] => rowsByShelf.get(shelfId) ?? NO_ROWS,
    [rowsByShelf],
  );

  /**
   * The rows behind each piece of art — the other half of {@link tiles}, kept apart from it
   * because the wall draws one and the *drag* carries the other.
   *
   * A tile is a printing; the entries behind it are what a folder actually files, and they can
   * differ in finish, condition, language and — the term that makes this a question at all —
   * **folder**. So the drag hands a folder every one of them and the page decides what to do
   * with the several ({@link fileCard}), rather than the wall inventing a single id it does not
   * have.
   *
   * **Keyed by the tile — {@link tileKeyOf}, the very function {@link tiles} and the wall's ring
   * composite are built from — and this map was keyed by the *card* until 2026-08-26.** That was
   * correct for exactly as long as a tile was all of a printing's finishes: a menu or a drag
   * acting on every row of the printing was acting on everything the picture stood for. The
   * moment the finish joined the wall's grain it stopped being correct, and in the quietest
   * possible way: a foil tile's `Move to` reached the plain copies, while the badge in the corner
   * of that same tile counted one. A control acting on cardboard the reader is not pointing at,
   * with the tile itself saying otherwise, is precisely the silent wrongness the split exists to
   * remove — and *no test went red either way*, which is why it was worth fixing at once rather
   * than filing.
   *
   * **What is still a *list* rather than a single id is the point of the map.** One finish of one
   * printing in one folder is still several rows — they differ in grade and in language — so a
   * drag still hands a folder every one of them and the reader still answers which
   * ({@link fileCard}). The split narrowed *which* rows are behind
   * a picture; it did not turn the several into one.
   *
   * **Built from the loaded, filtered rows, which is exactly what the tile claims.** The tile's
   * copy count is summed from these same rows under the same key, so "what moves" and "what the
   * picture says it is" are one list by construction. A later page of the same printing is not in
   * it — and must not be: the reader is filing what is on screen.
   */
  const copiesByTile = useMemo(() => {
    const out = new Map<string, CollectionCopy[]>();
    for (const row of rows) {
      const key = tileKeyOf(row.cardId, row.finish, row.folderId);
      const held = out.get(key) ?? [];
      held.push({ entryId: row.id, folderId: row.folderId });
      out.set(key, held);
    }
    return out;
  }, [rows]);

  /**
   * What a wall tile carries when it is picked up — **two marks in one flat record**, which is
   * why this is `CardGrid`'s `dragRecord` and not its `dragPayload`.
   *
   * The card half is what a deck category and the sidebar's Decks entry have always taken from
   * the collection's *table* rows; the tile half is what a shelf heading and a breadcrumb segment
   * read. Neither reader can see the other's key, which is `collectionDrag.ts`'s whole argument.
   *
   * `null` for a printing with no loaded row — impossible while the tile is drawn from those very
   * rows, and answered rather than asserted, because `CardGrid` reads this once at attach and
   * again at `dragstart` and a `null` there is honestly "this cannot be picked up".
   *
   * Its identity moves only with {@link copiesByTile}, i.e. when the rows change — never on a
   * bare re-render, which is what `CardGrid`'s own note asks for: a fresh arrow every render
   * tears the registration down and rebuilds it on every scrolled row.
   */
  /** The rows behind one tile, as the ids a menu target carries. **`tile.key`, not `tile.id`** —
   *  a `Move to` from a foil tile must reach that tile's rows and no others. */
  const entryIdsOf = useCallback(
    (tile: CollectionTile) => (copiesByTile.get(tile.key) ?? []).map((copy) => copy.entryId),
    [copiesByTile],
  );

  const tileDrag = useCallback(
    (tile: CollectionTile): Record<string, unknown> | null => {
      // The tile's rows, by the tile's own key. **The two `cardId`s below stay `tile.id`**, and
      // the reason differs per half.
      //
      // The tile half's is what a heading and a breadcrumb caption say the reader is filing
      // ("Move 2 copies of Lightning Bolt"), and the rows it travels with are already narrowed —
      // it is a label, not an address. It has no consumer that reads it as an address at all.
      //
      // **The card half's is a known limitation rather than a decision.** `deck_add_card` does
      // take a finish (`DeckFinish`), but `dragData`'s `{ kind: "card" }` payload has **no finish
      // slot** — only its `deckCard` sibling does — so a foil tile dropped onto a deck category
      // lands as a plain card. That predates the split and this task does not widen `dnd.ts` to
      // fix it; what the split changed is that the loss is now *avoidable*, because the tile
      // finally knows which finish the reader pointed at.
      const copies = copiesByTile.get(tile.key) ?? [];
      if (copies.length === 0) return null;
      return {
        ...dragData({
          kind: "card",
          cardId: tile.id,
          name: tile.name,
          typeLine: tile.typeLine,
        }),
        ...collectionTileDragData({ cardId: tile.id, name: tile.name, copies }),
      };
    },
    [copiesByTile],
  );

  /**
   * The question a drop asks when the tile it was given stands for more than one row, or `null`
   * while nothing is being asked — the destination travels with it, because the heading that
   * took the drop is gone from the conversation by the time the reader answers.
   */
  const [picking, setPicking] = useState<{
    cardName: string;
    entryIds: readonly number[];
    folderId: number | null;
  } | null>(null);

  /**
   * The collection as a **walk**, so the printings modal's chevrons and arrow keys step along it.
   *
   * **Built from {@link tiles} rather than from `rows`, and that is the honest source of the
   * two.** A walk's stops are printings — the modal answers a foil entry and a played nonfoil of
   * one printing with the same wall and the same ring — so `listWalkStops` de-duplicates by card
   * id, which is what keeps the walk one stop per printing now that the wall draws two tiles for
   * one. Feeding it `rows` would land on the same list by the same de-duplication while losing
   * the fallback name an orphaned entry gets here, which is two definitions of one thing with
   * only one of them complete.
   *
   * The table is walked by the same list, and that is right rather than a compromise: the two
   * layouts are one collection in one order, and a press that meant something different
   * depending on which was on screen would be two answers to one question.
   */
  const walk = useMemo(
    () => listWalkStops(tiles, (tile) => ({ cardId: tile.id, oracleId: tile.oracleId, name: tile.name })),
    [tiles],
  );
  usePublishCardWalk("your collection", walk);

  // Once per session, on the first load that has rows: everything the user owns gets its
  // art cached in the background, so the collection browses without a network. Keys already
  // on disk are skipped by the query, which is what makes repeat calls cheap and the job
  // resumable across sessions.
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current || rows.length === 0) return;
    warmed.current = true;
    void ipc.prewarmCollection().catch(() => {});
  }, [rows.length]);

  /**
   * The right-click menu, as one object for the whole page — the table's rows and the wall's
   * tiles are two drawings of one collection, and a menu whose writes differed between them
   * would be two answers to one question.
   *
   * "View all printings" is live on every healthy row and tile, and greyed only where the
   * entries behind it are orphans — `CollectionRow.oracleId` is what makes that distinction
   * reachable, and it is passed through untouched by both adapters above.
   */
  /**
   * The menu's half of the same question the drag asks — `Move to → <folder>` on a wall tile.
   *
   * **The same dialog, opened from the other door.** `collection-folders.md` records that these
   * two gestures have already drifted once, when the menu's settle set took `["decks"]` and the
   * drag's did not; a second implementation of "which copies?" is the same mistake one layer up,
   * so the row hands its ids here and this sets the very state a drop sets.
   *
   * The name is read off the first row rather than passed down: `moveItem` knows entry ids and
   * nothing about printings, and the list is the page's.
   */
  const pickCopies = useCallback(
    (entryIds: readonly number[], folderId: number | null) => {
      const first = rows.find((row) => row.id === entryIds[0]);
      setPicking({
        cardName: first?.name ?? "these copies",
        entryIds,
        folderId,
      });
    },
    [rows],
  );

  /**
   * The other question a row's menu can raise — `Edit copy…`, which is a grade and a price rather
   * than a destination.
   *
   * **The id and nothing else**, which is `cardMenu.tsx`'s side of the same division: the menu
   * knows a `collection_entries` id, this page is the one holding the list that id names, and the
   * row is looked up where the dialog is drawn ({@link editing}) rather than snapshotted here. A
   * copy the list has lost between the right-click and the press is then a dialog that does not
   * open, which is the honest answer — the copy is gone and so is the question.
   *
   * **No {@link openerRef}, and it is not an omission.** {@link open} exists to remember the
   * heading control that raised a layer so the caret can go back to it; a `MenuAction.onSelect`
   * has no element behind it and the menu's panel has already closed by the time this runs, so
   * there is nothing to remember. The copy picker beside it sets its state the same bare way.
   */
  const editCopy = useCallback((entryId: number) => {
    setPanel({ kind: "editCopy", entryId });
  }, []);

  /**
   * The copy the editor is about, as {@link EditCopy} needs it — or `null`, which is what closed
   * means to that dialog.
   *
   * **Looked up in the rows on screen rather than fetched**, which is {@link pickCopies}' rule for
   * the card's name one paragraph up: the menu was built from this very list, so the row is in
   * hand and a second read would be a round trip for a record already rendered.
   *
   * **A row the list no longer carries closes the question**, and that is the honest answer rather
   * than a defensive one: the id came off a menu built moments ago, so a miss means another window
   * removed the copy or the reader's own filter moved past it — either way there is nothing left
   * to edit, and a dialog drawn over a blank would ask about a copy that is not there.
   */
  const editing = useMemo<EditCopyTarget | null>(() => {
    if (panel?.kind !== "editCopy") return null;
    const row = rows.find((r) => r.id === panel.entryId);
    if (row === undefined) return null;
    return {
      entryId: row.id,
      // The orphan fallback every adapter on this page uses: a printing `cards` has forgotten
      // still has the set and number the entry recorded.
      cardName: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
      setCode: row.setCode,
      collectorNumber: row.collectorNumber,
      // Both raw, and narrowed by the dialog rather than here: they are TEXT with a CHECK, and
      // the surface that *draws* a word this build cannot name is the one that has to decide what
      // to draw instead.
      finish: row.finish,
      condition: row.condition,
      purchasePrice: row.purchasePrice,
      purchaseCurrency: row.purchaseCurrency,
      folderName: row.folderName,
    };
  }, [panel, rows]);

  const { menu, menuKey, menuClick } = useContextMenu();
  const { deps: baseMenuDeps, error: menuFailure } = useCardMenuDeps();
  /**
   * The app-wide deps plus the two writes only this page can offer.
   *
   * `pickCopies` is here rather than in `useCardMenuDeps` because it is a fact about *this
   * surface's targets*: a wall tile stands for several `collection_entries` rows, and no other
   * surface in the app draws a target that does. Every other page leaves it out and `moveItem`
   * files directly, exactly as it always has.
   *
   * `editCopy` is here for the near-opposite reason and lands in the same place: it needs a target
   * that names **one** row the reader pointed at, which in this app is the collection table's row
   * and nothing else — so the hook would be publishing a dep for a surface that cannot use it.
   */
  const menuDeps = useMemo<CardMenuDeps>(
    () => ({ ...baseMenuDeps, pickCopies, editCopy }),
    [baseMenuDeps, pickCopies, editCopy],
  );

  /**
   * The reader's own cabinet — the folders they made and named, and nothing the app owns.
   *
   * `collection_folders.kind` is one of three: `user`, the `deck` folder that stands for a deck,
   * and the single `removed` one. Only the first is a drawer the reader arranged, so only the
   * first belongs in the nestable tree they drag between and rename. **The other two are shelves
   * under the Decks label** — shut by default, never draggable, never renamed and never a drop
   * target (`CollectionShelfParts` and `buildShelves` carry both halves of that).
   *
   * The filter is on the *tree's* input alone. {@link trailOf} and `folderNameOf` below read the
   * whole list, so the breadcrumb can still walk a reader out of a deck group they have opened.
   */
  const userFolders = useMemo(
    () => folders.folders.filter((folder) => folder.kind === "user"),
    [folders.folders],
  );

  /** The other two kinds, split by kind — the holding area is what `Clear…` and the stepper's
   *  fence ask about, and the deck groups are the drag's source fence. */
  const pinned = useMemo(() => pinnedFolders(folders.folders), [folders.folders]);

  /**
   * An app-owned folder's own figures — `Recently removed`'s, for `Clear…`.
   *
   * **The summary row directly, never {@link subtotalsOf}**: that map is built by walking the
   * reader's tree, and these folders are deliberately not in it. Nothing can nest under a deck
   * group or under `Recently removed` — no command writes a `parent_id` naming one — so the
   * direct count *is* the recursive count here, and there is nothing to add up.
   *
   * `null` while the summary has not answered: a `Map.get` miss means "empty" once it has and "not
   * counted yet" before it has, and `0 cards` over a pile of sixty is a wrong number.
   */
  const pinnedTotals = useCallback(
    (folder: CollectionFolder): CollectionFolderTotals | null =>
      folders.summaryQuery.isPending ? null : (folders.summary.get(folder.id) ?? NO_CARDS),
    [folders.summaryQuery.isPending, folders.summary],
  );

  /**
   * The cabinet, as a tree, and where the reader is standing in it.
   *
   * `buildFolderTree(userFolders, [])` with **no members**, which is the one thing about this call
   * that is not obvious: `FolderNode.count` would be the number of rows filed under a node, and
   * this page holds one level's rows rather than the whole list, so counting from them would
   * answer 0 for every folder that is not the one on screen. The counts come from
   * `collection_folder_summary` instead, summed up the tree by {@link subtotalsOf}. The tree is
   * still what says which folder is under which, and it is what applies the missing-parent rule
   * that {@link trailOf} applies from the other end.
   */
  const nodes = useMemo(() => buildFolderTree(userFolders, []), [userFolders]);
  const trail = useMemo(() => trailOf(folders.folders, folderId), [folders.folders, folderId]);
  const subtotals = useMemo(() => subtotalsOf(nodes, folders.summary), [nodes, folders.summary]);

  /**
   * What to call a folder, for the two sentences the layers below build out of one.
   *
   * A `Map` and not a `find` per call: the strip names a folder three times over while it is open,
   * and the whole list is already in memory. `null` — a folder id this page cannot name — is what
   * every call site turns into its own fallback, which is the honest answer for a drawer another
   * window deleted between the two reads.
   *
   * The **table** does not go through here: `CollectionRow.folderName` is the backend's own join,
   * so a row names its drawer without this page having to hold both halves.
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
   * The drawers the reader has set aside — **every folder inside a locked one included** (issue
   * #365, design §3). `useCollection` computes it once, from the same census, because a shelf's
   * `locked` is this answer too; the page reads the hook's set rather than deriving a second one.
   */
  const { lockedIds } = collection;

  /** Every folder by id — a heading is built from its shelf, and the menu and the drag source
   *  want the row behind it. */
  const folderById = useMemo(
    () => new Map(folders.folders.map((folder) => [folder.id, folder])),
    [folders.folders],
  );

  /**
   * Every reader's folder's parent **as the tree draws it** — `null` for the root — which is what
   * a before/after drop beside a heading reorders, and what Move up / Move down step within. See
   * {@link treeParents} for why this is not the row's own `parentId`.
   */
  const treeParent = useMemo(() => treeParents(nodes), [nodes]);

  /**
   * **The caret handed back to a heading that may no longer be drawn** (live pass, check 8) — after
   * Add folder in a heading, to its `Add folder`, and after Move up / Move down, to the moved
   * heading's `⋯`. `useHeadingCaret` is the whole machine, shared with the wishlist; the page asks
   * for a request at the press, records it when its moment comes, and hands the due one to its
   * heading (`caretFor`) and to both views' reveal (`caretDue`). Called here, where the folder tree
   * a move is decided against exists.
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
    levelIds: (parentId) => folderLevel(nodes, parentId).map((node) => node.folder.id),
  });

  /**
   * What the Share control is about — **the level on screen**, and `null` where this level has
   * nothing to publish.
   *
   * The level rather than a row of the wall, because the root is a target too and the root has no
   * card to hang a control on. Standing in a drawer is therefore how a reader shares one, and the
   * breadcrumb above the wall is what says which drawer that is.
   *
   * **A `folderId` naming a folder this list no longer carries is the root**, which is
   * {@link trailOf}'s rule read from the other end and the same answer the wall is already
   * drawing — never *no control*, which would be this one control disagreeing with the
   * breadcrumb about where the reader is standing.
   *
   * `lockedIds` and not `folder.locked`, because `share::snapshot` drops a folder with a locked
   * ancestor exactly as it drops a locked one — the effective answer, like every other consumer
   * of the lock on this page.
   */
  const shareTarget = useMemo(() => {
    const here = folderId === null ? null : (folders.folders.find((f) => f.id === folderId) ?? null);
    if (here === null) return shareTargetFor(null, false);
    return shareTargetFor(here, lockedIds.has(here.id));
  }, [folderId, folders.folders, lockedIds]);

  /**
   * The **folder** members of {@link Panel}, which is what everything below this line is about.
   *
   * `editCopy` is drawn from the collection's rows rather than from its cabinet, so neither rule
   * under this heading applies to it: its trigger is a card's context-menu row, and it has no level
   * to compare against. It is also not the page's Escape rung's business — a `Dialog` registers its
   * own.
   *
   * **`removeCopies` is on this side of the line although it is not about a folder** (issue #555),
   * because what puts a member here is where it is drawn rather than what it is about: it is a
   * question in the strip above the wall, which needs this page's Escape rung and its `dismiss`,
   * where `editCopy` is a `Dialog` that brings both of its own. No wall rule below closes it — the
   * rows it is about are named by id, not by the level on screen.
   */
  const folderPanel = panel === null || panel.kind === "editCopy" ? null : panel;
  /** Standing in the holding area — the one level whose path row carries `Clear…`. */
  const inRemoved = pinned.removed !== null && folderId === pinned.removed.id;
  /**
   * Whether a folder has a heading on this wall — at or below the level, drawn or folded away.
   * `null` is the root, which has a heading on no wall but is the level itself at the top.
   */
  const onThisWall = useCallback(
    (id: number | null) =>
      id === folderId ||
      collection.shelves.some((shelf) => shelf.id === id && !shelf.headless),
    [folderId, collection.shelves],
  );
  /**
   * **A layer goes with the wall it was opened on, derived rather than written from an effect.**
   * A naming field is drawn *by* a heading — the new folder's placeholder heading, or the renamed
   * folder's own — so a field whose heading is no longer on this wall would be a layer with nothing
   * on screen, still swallowing the Escape that should walk the reader back out. So walking into
   * another folder closes a new folder whose parent is not on the new wall, and a rename whose
   * folder has no heading there (it is the level now, or somewhere else entirely). `clearRemoved`
   * goes with `Recently removed`, because its trigger is drawn only there.
   */
  const openPanel =
    (folderPanel?.kind === "newFolder" && !onThisWall(folderPanel.parentId)) ||
    (folderPanel?.kind === "renameFolder" &&
      (folderPanel.folderId === folderId || !onThisWall(folderPanel.folderId))) ||
    (folderPanel?.kind === "clearRemoved" && !inRemoved)
      ? null
      : folderPanel;

  /**
   * The Add folder a naming field was opened from, when that is a **heading's** — the one whose
   * caret has to be handed back by request (`useHeadingCaret`). The path row's makes a folder *at*
   * the level, its parent is the level itself, and its button is never scrolled away. Not sorted
   * also creates at the root, so its origin shelf id is kept separately from the null parent.
   */
  const headingAddedIn =
    panel?.kind === "newFolder"
      ? (panel.originShelfId ??
        (panel.parentId !== null && panel.parentId !== folderId ? panel.parentId : null))
      : null;

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab restarts from
  // the top of the app. This is the **keyboard** way out — Escape, and each panel's own Cancel.
  // `close` below is the click-away way and is deliberately a different function: CLAUDE.md's rule
  // is that an outside click does *not* hand the caret back, because the reader is already
  // somewhere else.
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
   * **Add folder's field, given up** — its ✕, or the reader clicking or tabbing away, which
   * `FolderNameField` answers with the same `onCancel` (its blur discard). Escape never reaches
   * here: the page's `"inner"` rung takes it and calls {@link dismiss}.
   *
   * **The ✕ is a keyboard cancel's twin** — the caret is on it, inside the field — so it is
   * {@link dismiss}, and a heading's Add folder records its caret return.
   *
   * **A blur discard is an outside click, and an outside click does not hand the caret back**:
   * the field closes and nothing is focused, because the reader is already somewhere else — a
   * click on a tile below the draft must neither scroll the wall back up to the parent nor take
   * the caret off the tile (review Minor 5). While the blur runs the caret is on `<body>` on its
   * way to wherever it is going, so the question waits one task (`afterBlur`): **only if
   * it is still nowhere** is the heading's request recorded (revealed first). The request is made
   * at the blur, so anything newer — a layer opened by the click that blurred the field, another
   * request — supersedes it before the task runs.
   *
   * **The path row's field decides the same way** (the final review's C-I3): its button is never
   * scrolled away, but a focus made from inside a `focusout` handler is one Blink refuses the click
   * its own focus — so `dismiss` there took the caret off whatever was clicked and scrolled the page
   * to the top. One task later, and only if the caret is still nowhere, it goes back to the path
   * row's Add folder, **without scrolling** — the page stays where the reader was.
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
   * One level up — **the breadcrumb's own second-to-last segment, read rather than re-derived**.
   *
   * {@link trailOf} ends with the folder the reader is standing in, so the step before it is the
   * one the breadcrumb draws as the last *pressable* segment, and an empty step is the root. That
   * is `null`, which for this cabinet is the copies filed **nowhere** — and, since shelves, the whole
   * cabinet on one wall. Either way the two ways out land in the same place by construction
   * rather than by two pieces of arithmetic that happen to agree.
   *
   * **A deck group and `Recently removed` need no branch here, and that is a fact about `trailOf`
   * rather than luck.** It is handed `folders.folders` — every kind — where the *tree* above it is
   * handed `userFolders`, so a reader standing in a pinned folder has a one-segment trail and this
   * answers the root. Schema v25 writes `parent_id` `NULL` on every pinned row and no command can
   * nest anything under one, so a one-segment trail is the only shape either can take.
   *
   * A `folderId` naming a folder this list no longer carries answers the root too — `trailOf`
   * resolves a broken parent *towards* the root for exactly the reason this reads it: the
   * alternative strands the reader inside a drawer with no way out.
   *
   * **Stepped from the level asked for (`requestedFolderId`), which is the breadcrumb's own trail
   * whenever the two agree.** The breadcrumb draws the level on screen, and while a level nothing
   * has cached is arriving the two differ by one press — so a second Escape inside that round trip,
   * stepped from the breadcrumb, would land on the level already asked for and do nothing. Two
   * presses are two levels.
   */
  const askedTrail = useMemo(
    () => (requestedFolderId === folderId ? trail : trailOf(folders.folders, requestedFolderId)),
    [requestedFolderId, folderId, trail, folders.folders],
  );
  const parentFolderId = askedTrail.length >= 2 ? askedTrail[askedTrail.length - 2].id : null;

  /**
   * Escape walks the reader out of a drawer — the floor rung, and the same step the breadcrumb's
   * last pressable segment takes.
   *
   * **`enabled` on `requestedFolderId !== null` is what keeps the press from being swallowed at the
   * root.**
   * A registered layer takes the press whether or not it has anywhere to go, and a `"navigation"`
   * rung that consumed Escape at the top of the cabinet would be a floor with nothing under it:
   * every press a reader made on this page would stop here and reach nothing else that might one
   * day want the last one.
   *
   * The filter box is what makes this safe to have at all rather than a courtesy laid over it —
   * `clearFieldOnEscape` in `FilterBar` — because Chromium empties an
   * `<input type="search">` on Escape by itself and does **not** mark the press handled, so
   * without it one press would clear the box *and* walk the reader up a level.
   */
  useDismissOnEscape({
    layer: "navigation",
    onDismiss: () => collection.openFolder(parentFolderId),
    enabled: requestedFolderId !== null,
  });

  const open = useCallback((next: NonNullable<Panel>, opener: HTMLElement | null) => {
    openerRef.current = opener;
    // A caret still owed to a heading is the last layer's business, not this one's — and a request
    // whose write has not answered yet, or whose blur is still deciding, is superseded, so it is
    // never recorded at all.
    supersedeCaret();
    setPanel(next);
  }, [supersedeCaret]);

  /**
   * **Add folder** — on the path row it makes one at the level the reader is standing in, and on a
   * heading it makes one inside that folder (spec §3.8). Either way the new folder appears where it
   * will live: a placeholder heading, last among its siblings, over an empty shelf, with the name
   * typed on the line the name will occupy.
   *
   * **A shut parent opens first**, through the same write its chevron makes, so the new heading has
   * somewhere to be drawn; the stored fold goes back to the default rather than to "open", which is
   * what the chevron would store too.
   *
   * **The opener is read off the focus**, because `ShelfToolbar` and `ShelfHeading` both hand a bare
   * callback: a pointer press and a keyboard press alike leave the button that was pressed focused,
   * and that is the element {@link dismiss} gives the caret back to. `folders.create.reset()` for
   * `DecksPage`'s reason: a refusal from the last attempt is not news about this one.
   */
  // Taken off the hook here rather than with the wall's other fields below, because Add folder is
  // the first callback that needs them — and a method called through `collection.` would make the
  // whole hook result a dependency.
  const { shelves: builtShelves, setFold, folds: storedFolds } = collection;
  const openNewFolder = useCallback(
    (parentId: number | null, originShelfId?: number) => {
      createReset();
      const parent =
        parentId === null
          ? undefined
          : builtShelves.find((shelf) => shelf.id === parentId && !shelf.headless);
      if (parent !== undefined && parent.collapsed) {
        setFold(parent.id, foldChange(parent, false));
      }
      open({ kind: "newFolder", parentId, originShelfId }, focusedElement());
    },
    [createReset, builtShelves, setFold, open],
  );

  /** **Rename**, on the heading itself — the field replaces the title in place (spec §3.8), and
   *  `ShelfHeading`'s own `useFolderFieldReturn` hands the caret back to the Rename button it
   *  draws again, which is a new element by then. */
  const openRename = useCallback(
    (id: number) => {
      renameReset();
      open({ kind: "renameFolder", folderId: id }, focusedElement());
    },
    [renameReset, open],
  );

  /**
   * The field, answered — whichever of its two jobs it is doing.
   *
   * One callback because there is one field: which write a name becomes is a fact about the open
   * `Panel`, which this component owns, rather than something the field has to be told and then
   * hand back.
   *
   * **A new folder does not become the folder the reader is standing in**, the wishlist's call and
   * for its reason: the reader is looking at the cards they are about to file, and walking them
   * into the new empty drawer would take exactly those cards off screen and replace them with
   * `Nothing filed here yet.` The card they just made is right there to drag onto.
   *
   * **A made folder starts on its own kind's fold** (the final review's R-M2):
   * `collection_folders.id` is an `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so a new folder
   * can take a deleted folder's id — and with it whatever fold was stored under that id. The create
   * clears it, and only where something is stored, so an ordinary create writes nothing.
   *
   * **The path row's caret comes back without scrolling** (ledger 217): the new heading is drawn
   * last among its siblings, often well below the path row, and the return is the button the reader
   * pressed — spec §3.8's — so an ordinary `focus()` took the page to the top and off the folder
   * just made. A heading's Add folder is {@link dismiss}'s request, which reveals the heading.
   */
  const nameFolder = useCallback(
    (name: string) => {
      if (panel?.kind === "newFolder") {
        const pathRow = headingAddedIn === null;
        createMutate(
          { parentId: panel.parentId, name },
          {
            onSuccess: (made) => {
              if (storedFolds[String(made.id)] !== undefined) setFold(made.id, null);
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
        renameMutate({ id: panel.folderId, name }, { onSuccess: dismiss });
      }
    },
    [panel, headingAddedIn, createMutate, renameMutate, storedFolds, setFold, dismiss],
  );

  /**
   * **Move up / Move down** (spec §3.2) — the keyboard's reorder, which WCAG 2.5.7 asks for
   * wherever a drag is the other way to do it. A step is a before/after drop on the neighbour, so it
   * goes through the same `reorderedLevel` a heading drop does and writes the same level order.
   * `null` at either end of the level, which the menu greys.
   */
  const stepPlacement = useCallback(
    (id: number, step: -1 | 1): { parentId: number | null; ids: number[] } | null => {
      const parentId = treeParent.get(id) ?? null;
      const siblings = folderLevel(nodes, parentId).map((node) => node.folder.id);
      const at = siblings.indexOf(id);
      const neighbour = siblings[at + step];
      if (at === -1 || neighbour === undefined) return null;
      const ids = reorderedLevel({
        siblings,
        dragged: id,
        target: neighbour,
        edge: step === -1 ? "before" : "after",
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [treeParent, nodes],
  );

  /**
   * One heading's three doors into one menu — a right-click, a `ContextMenu` keypress, and the
   * `⋯` trigger's own plain click, which is what {@link useContextMenu.menuClick} exists for.
   *
   * The item list is a **thunk** inside each handle, so a level holding twelve drawers builds no
   * menu until a reader opens one of them.
   *
   * **The opener is captured here rather than by the card**, because the panel a row raises has to
   * hand the caret back to the control it was raised from and a `MenuAction.onSelect` is a bare
   * callback with no element behind it. `e.currentTarget` is read synchronously, which is the only
   * moment it is the element the handler is attached to.
   */
  const folderRowMenu = useCallback(
    (folder: CollectionFolder) => {
      // Whether the drawer is set aside, and whether that is the reader's press on *this* card or
      // a decision they made further up the tree. The two are different rows' answers: Lock/Unlock
      // is about this folder's own flag and is greyed by the ancestor, where Delete is about the
      // effective lock and is greyed by either.
      const inherited = !folder.locked && lockedIds.has(folder.id);
      const effectivelyLocked = folder.locked || inherited;
      /** The phrase a greyed row carries, which is a *phrase* rather than `FOLDER_IS_LOCKED`'s
       *  whole sentence: a menu row is as wide as its widest content, so one long reason sets the
       *  width of the entire panel. The two arms point at the two different things a reader would
       *  go and do next, which is the grammar {@link blockedReason}'s greyed rows already use. */
      const ancestorReason = "a folder above it is locked";
      /** A step, written — and once it has landed, the caret goes to this heading's `⋯` wherever the
       *  step put it. The request is made **at the press** and recorded when the write answers, so
       *  anything the reader opens in between supersedes it; the folder list's first answer after
       *  the write decides it (`caretDue`). */
      const step = (plan: { parentId: number | null; ids: number[] }) => {
        const request = askCaret(folder.id, "manage", { order: plan });
        reorderMutate(plan, { onSuccess: () => recordCaret(request) });
      };
      const build = (): MenuItem[] => {
        /** A locked folder anywhere **beneath** this one, which the delete would re-file with
         *  the rest — `delete_folder`'s `FOLDER_HOLDS_LOCKED`. Asked when the menu opens rather
         *  than for every card drawn, because it walks the tree. */
        const holdsLock =
          !effectivelyLocked &&
          [...folderDescendants(folders.folders, folder.id)].some((id) => lockedIds.has(id));
        return [
          // A file into this drawer, its subfolders untouched — the counterpart of the row under
          // it, which exports the drawer with everything inside it. Live on a locked folder: the
          // lock holds copies back from decks and refuses a delete, and adding cardboard to a
          // drawer set aside disturbs nothing in it.
          {
            kind: "action",
            id: "import",
            label: "Import…",
            Icon: Upload,
            onSelect: () => setImporting({ folderId: folder.id, fromMenu: true }),
          },
          {
            kind: "action",
            id: "export",
            label: "Export…",
            Icon: Download,
            onSelect: () => {
              setExportFolder(folder);
              setExporting(true);
            },
          },
          {
            kind: "action",
            id: "move",
            label: "Move to folder…",
            Icon: FolderInput,
            onSelect: () => {
              moveReset();
              open({ kind: "moveFolder", folderId: folder.id }, openerRef.current);
            },
          },
          (() => {
            const up = stepPlacement(folder.id, -1);
            return {
              kind: "action" as const,
              id: "up",
              label: "Move up",
              Icon: ArrowUp,
              ...(up === null ? { disabled: true, reason: "Already first" } : {}),
              onSelect: () => {
                if (up !== null) step(up);
              },
            };
          })(),
          (() => {
            const down = stepPlacement(folder.id, 1);
            return {
              kind: "action" as const,
              id: "down",
              label: "Move down",
              Icon: ArrowDown,
              ...(down === null ? { disabled: true, reason: "Already last" } : {}),
              onSelect: () => {
                if (down !== null) step(down);
              },
            };
          })(),
          /**
           * **Set the drawer aside, or bring it back** — issue #365, and the one row here that is
           * neither a layer nor a field: it writes on the press, and what the reader watches change
           * is the badge on the card behind the menu.
           *
           * **It toggles the folder's *own* flag**, where every other consumer of the lock on this
           * page reads the effective one. That asymmetry is the feature rather than an
           * inconsistency: the reader locks a drawer and gets the drawer, including whatever they
           * have nested inside it — so there is one row per folder to press and no second copy of
           * the fact to disagree with the first.
           *
           * **Greyed, with its reason in the row's accessible name, when an ancestor is locked.**
           * Unlocking a child of a locked parent changes nothing a reader can see — the lock on the
           * heading stays — and a row that reported success over an
           * unmoved badge is worse than a greyed one. `Move to folder…` and the two steps above stay
           * live in every state, deliberately: neither disturbs a card, so neither is what the lock
           * is about (design §4.4).
           *
           * Above the separator, with the other two live rows: the rule below it is *destructive*,
           * and locking is reversible in one press.
           */
          {
            kind: "action",
            id: "lock",
            label: folder.locked ? "Unlock folder" : "Lock folder",
            Icon: folder.locked ? LockOpen : Lock,
            disabled: inherited ? true : undefined,
            reason: inherited ? ancestorReason : undefined,
            onSelect: () => {
              setLockedReset();
              setLockedMutate({ id: folder.id, locked: !folder.locked });
            },
          },
          { kind: "separator", id: "before-delete" },
          /**
           * **Greyed on the *effective* lock**, which is `delete_folder`'s own fence said early:
           * deleting re-files every card in the sub-tree to the root, silently undoing exactly the
           * filing the lock was protecting, so the backend refuses it in words (`FOLDER_IS_LOCKED`)
           * for a folder inside a locked parent as surely as for the one the reader pressed Lock on.
           * **And the UI must not let the press happen**: the rule app-owned shelves follow is that
           * a control whose only outcome is a sentence explaining that it does not work teaches the
           * reader nothing its absence would not have. An app-owned heading answers it by omitting
           * the menu; a locked drawer keeps its menu, so this greys with its reason in the row's
           * accessible name.
           *
           * **And on a lock anywhere beneath it** (`holdsLock`), which the backend refuses in words
           * of its own (`FOLDER_HOLDS_LOCKED`): the delete re-files the whole sub-tree, so a locked
           * folder inside this one is scattered by this press as surely as by its own.
           */
          {
            kind: "action",
            id: "delete",
            label: "Delete…",
            Icon: Trash2,
            disabled: effectivelyLocked || holdsLock ? true : undefined,
            reason: effectivelyLocked
              ? inherited
                ? ancestorReason
                : "unlock it first"
              : holdsLock
                ? "a folder inside it is locked"
                : undefined,
            onSelect: () => {
              removeFolderReset();
              open({ kind: "deleteFolder", folderId: folder.id }, openerRef.current);
            },
          },
        ];
      };
      const remember = (element: HTMLElement) => {
        openerRef.current = element;
      };
      return {
        onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
          remember(e.currentTarget);
          menu(build)(e);
        },
        onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
          remember(e.currentTarget);
          menuKey(build)(e);
        },
        onClick: (e: ReactMouseEvent<HTMLElement>) => {
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
      lockedIds,
      stepPlacement,
      folders.folders,
      moveReset,
      removeFolderReset,
      reorderMutate,
      setLockedReset,
      setLockedMutate,
      askCaret,
      recordCaret,
    ],
  );

  /**
   * **Every drop on this page, and the lock's question** — `useCollectionDrops` since issue #557:
   * a copy let go on a heading, an empty shelf, the sticky bar or a breadcrumb segment, a printing
   * dropped off the sidebar's search wall, a folder heading dropped on another heading or on a
   * path-row segment, and the drawer boundary a drag may cross only after asking. Each rule is
   * argued at its new home; what the page keeps is where each answer is drawn.
   *
   * Called here, where the census, the two trees and the name lookup it decides against exist, and
   * handed the two writes a drop reuses as their `mutate` — held still, so the callbacks it answers
   * with are too.
   */
  const {
    addDropped,
    crossing,
    setCrossing,
    readersOwnLevel,
    canFile,
    commitFile,
    fileCard,
    blockedReason,
    canPlaceFolder,
    placeFolder,
    canPlaceOnLevel,
    placeOnLevel,
  } = useCollectionDrops({
    census: folders.folders,
    userFolders,
    deckGroups: pinned.decks,
    lockedIds,
    nodes,
    treeParent,
    folderNameOf,
    setFolder: setFolderMutate,
    reorder: reorderMutate,
    setPicking,
  });

  /**
   * **May the copies filed here have their count changed — stepped, stepped to zero, or removed
   * from the right-click menu.** {@link readersOwnLevel} plus `Recently removed`, and nothing else.
   *
   * Issue #506. The fence on a count exists for **deck custody**: a copy in a deck's group is the
   * deck's arithmetic, `collection::set_quantity` has no folder fence of its own, and a stepper
   * there would change what a deck says it owns without the deck being touched — which is why
   * those copies leave through `deck_to_collection` and nowhere else. `Recently removed` is the
   * opposite case. Its copies are the ones a deck *let go of*, they belong to no deck, and changing
   * their count changes no deck's list; fencing them made the holding area a pile the reader could
   * sort out only by dragging every copy back into a binder first, including the ones they meant
   * to throw away.
   *
   * **Its own predicate rather than a widening of {@link readersOwnLevel}**, because that one still
   * answers two questions whose answer for the holding area is unchanged: nothing may be dropped
   * *into* it and no folder may be made inside it (`user_folder` refuses both). Folding the two
   * together would have turned those on along with this.
   *
   * **Written positively, for the same reason that one is**: a fifth
   * `collection_folders.kind` added later is fenced here until somebody decides it should not be.
   * And fenced until the census answers, for the same reason — `pinned.removed` is `null` while the
   * folder list is empty, so a row in the holding area draws no stepper for one query and then
   * grows one.
   */
  // `entryFences.ts`' `countEditableIn` since 2026-10-03 — the same predicate over the same census,
  // asked by the light app's phone face too, so the two cannot answer it two ways.
  const countEditable = useCallback(
    (id: number | null) => countEditableIn(folders.folders, id),
    [folders.folders],
  );

  /**
   * Which `collection_entries` row a press on a tile's stepper writes to — **the wall's twin of
   * {@link copiesByTile}**, and absent where the wall draws no stepper at all.
   *
   * # Why it is not beside its twin
   *
   * {@link copiesByTile} sits with {@link tiles} because both are pure over `rows`. This one is
   * not: its fence is {@link countEditable}, which is built from the folder census read further
   * down the page, so it can only be stated after the cabinet is. Reading it up there would be a
   * temporal dead zone rather than a style choice.
   *
   * # The fence
   *
   * A stepper is drawn only where the tile's folder is the root, a drawer the reader made, or
   * `Recently removed` (issue #506 — see {@link countEditable} for why the holding area joined).
   * **Every row behind a tile shares its folder since shelves** (decision 11), so "every row" and
   * "the tile's folder" are one question now: the mixed tile this fence was written against — a
   * sum partly in a deck's custody — can no longer be drawn. The loop still asks it per row, which
   * costs nothing and stays right if the grain ever widens again.
   *
   * **A filed tile is fenced until the census has answered**, which is the fail-*closed* direction
   * and is deliberate: `useCollectionFolderList` starts empty, and "empty" is a collection nobody
   * has filed as well as one that has not loaded — that hook says so at its own site. So a tile in
   * a drawer draws no stepper for the length of one query and then grows one, where the permissive
   * reading would draw a control over a deck's copies for exactly that window. The root needs no
   * census at all, which is most of the wall.
   *
   * # Which row, and what the floor is
   *
   * **The first row behind the art** — the same row {@link tiles} takes `id`, `name` and
   * `unitPrice` from, so the tile's identity and the tile's writes address one entry rather than
   * two. "First" is the query's **current sort order** and is therefore not stable across a
   * re-sort: the same picture can address a different entry after the reader presses a column
   * header. That is the accepted cost of the decision rather than an oversight — the alternative
   * is a dialog per press (which is what a *drag* gets, because a drag is already a question), and
   * the copies behind one tile differ only in grade, language and drawer, none of which a wall of
   * art shows.
   *
   * `floor` is `tile.copies - row.quantity`: the copies this stepper **cannot reach**, because they
   * belong to the rows it does not address. **Taken off the tile's own sum and never re-summed
   * here** — the badge in the corner and the number in the stepper are the same figure, so a second
   * walk over `rows` would be a second definition of it, and the two disagreeing is a control whose
   * floor is wrong in a way nothing on screen explains.
   *
   * Two consequences fall out of those two numbers rather than being special-cased. On the
   * ordinary single-entry tile `floor` is **0**, so stepping to zero deletes the entry exactly as
   * the table's stepper does (`collection::set_quantity(id, 0)` deletes — see `setQuantity`'s
   * `onSuccess`). And on a tile of 3 copies made of an NM row of 2 and a Played row of 1, `floor`
   * is **1**: `−` walks 3 → 2 → 1 and then disables, the NM row is gone, the wall re-reads its
   * rows, the Played row becomes first, the floor recomputes to 0 and `−` walks that one out too.
   *
   * # The key
   *
   * {@link tileKeyOf}, the same function {@link tiles} and {@link copiesByTile} are built from —
   * **the printing *and* the finish**. Keying by card alone would point a foil tile's stepper at
   * the plain copies while the badge six pixels above it counted the foils, which is the exact
   * silent wrongness {@link copiesByTile} records having shipped for its own `Move to`.
   */
  const stepperByTile = useMemo(() => {
    const first = new Map<string, CollectionRow>();
    const fenced = new Set<string>();
    for (const row of rows) {
      const key = tileKeyOf(row.cardId, row.finish, row.folderId);
      if (!first.has(key)) first.set(key, row);
      if (!countEditable(row.folderId)) fenced.add(key);
    }
    const out = new Map<string, { row: CollectionRow; floor: number }>();
    for (const tile of tiles) {
      const row = first.get(tile.key);
      // `undefined` is unreachable while the tiles are built from these very rows, and it is
      // answered rather than asserted for {@link tileDrag}'s reason.
      if (row === undefined || fenced.has(tile.key)) continue;
      out.set(tile.key, { row, floor: tile.copies - row.quantity });
    }
    return out;
  }, [rows, tiles, countEditable]);

  /**
   * Why one **table row's** copies cannot be stepped where they sit, or `null` for a row that can
   * — `CollectionTable`'s `quantityBlocked`, and the other half of the wall's fence above.
   *
   * **One predicate, two drawings.** The table and the wall are the same list in two layouts, so a
   * row the wall will not let a reader step and a row the table will is not a difference a reader
   * can make any sense of — and it is a difference two independently-written fences arrive at the
   * first time either moves. {@link countEditable} is the whole of the test on both sides;
   * everything below it is *words*, which is the only thing the two surfaces legitimately differ
   * in. The wall says it by drawing nothing (there is no room on a 170px tile for a sentence, and
   * the strip it would sit in is revealed on hover), where a table row has a whole cell and can
   * afford to say what to do instead.
   *
   * **The grain is a row here and a tile there, and that is not a second rule.** A tile is fenced
   * when *any* row behind it is; a row is fenced when it is. The wall's is that same predicate
   * over the several rows one piece of art sums, which is why {@link stepperByTile} does the
   * folding and this does not.
   *
   * # Which sentence
   *
   * The first arm names what the folder *is*, because it names the way out: copies in a deck's
   * group leave by being cut from the deck (`deck_to_collection`, which decrements `deck_cards` in
   * the same transaction). That is the grammar {@link blockedReason} already uses for the picker's
   * greyed rows — where you are, then what to do — so this feature speaks with one voice about a
   * refusal.
   *
   * **There were three arms until issue #506**, and the one that went said *In Recently removed.
   * Move it back to your collection to change how many you hold.* It was true about the fence and
   * wrong about the reason for it: the holding area's copies belong to no deck, so there was never
   * custody to protect, only a pile the reader could not thin without refiling it first. Those rows
   * are inside {@link countEditable} now and reach this function's first line.
   *
   * **The other arm names no mechanism, on purpose.** It is reached by a fourth
   * `collection_folders.kind` — the reason the fence is written positively at all — and a fourth
   * kind wearing the deck sentence would tell the reader to cut a card from a deck that does not
   * exist. So it says only what is certainly true of anything that is not the reader's own filing:
   * the copies are somewhere they did not put them, and the way to change the count is to move
   * them somewhere they did.
   *
   * **It is also, for the length of one query, what a row in the reader's own binder gets**, and
   * that is the cost of the fence failing closed. `useCollectionFolderList` starts empty and
   * "empty" is a cabinet nobody has filed as well as one that has not loaded, so until it answers
   * every filed row is outside {@link countEditable} and reads a sentence that is wrong about a
   * drawer the reader made. Accepted over the alternative, which is a live stepper standing over a
   * deck's copies for the same window against a `collection::set_quantity` that has **no folder
   * fence of its own** — a briefly wrong sentence self-corrects and a written quantity does not.
   * The root needs no census, so this is only ever about filed rows.
   */
  // `entryFences.ts`' `quantityRefusal` since 2026-10-03, its sentences verbatim.
  const quantityBlocked = useCallback(
    (row: CollectionRow): string | null => quantityRefusal(folders.folders, row),
    [folders.folders],
  );

  /**
   * Whether every copy behind a menu's target — and behind every picked target beside it — may
   * have its count changed, which is the whole of when the menu offers `Remove from collection`.
   *
   * **Every, not any**, {@link stepperByTile}'s rule and for its reason: the menu's press takes
   * *all* the ids it reaches in one write, so a pick that reached one copy in a deck's group would
   * take the deck's custody along with the rest. {@link canFile}'s "any" is right for a drag
   * because a drag asks which copies move; this press asks nothing.
   */
  const allCountEditable = useCallback(
    (copies: readonly { folderId: number | null }[]) =>
      copies.every((copy) => countEditable(copy.folderId)),
    [countEditable],
  );

  /**
   * `Remove from collection`'s press — one entry removes at once, more than one asks first
   * (issue #555).
   *
   * **One entry is the copy the reader pointed at**, and the press is the write, exactly as the
   * table's stepper walked to zero is: no question with one answer in front of it. **Several** is a
   * tile standing for more rows than the art shows, or a picked set, so the page asks in the strip
   * above the wall — `clearRemoved`'s place and recipe — and the menu row wears the ellipsis that
   * says a question comes first.
   *
   * **The opener is whatever holds the caret**, which by the time a row's handler runs is the tile
   * or table row the menu was opened on: the menu hands the caret back to its opener before it
   * runs a row. That is what `dismiss` gives it back to on Escape or Cancel.
   *
   * Declared down here rather than beside {@link removeMany} for {@link open}'s sake: a
   * `useCallback`'s dependency array is read during render, so naming a `const` declared further
   * down the component is a `ReferenceError` on the first paint.
   */
  const removeCopies = useCallback(
    (entryIds: readonly number[]) => {
      if (entryIds.length === 1) {
        const name = rows.find((row) => row.id === entryIds[0])?.name ?? null;
        removeManyMutate({ entryIds, name });
        return;
      }
      // A refusal left standing from the last press must not read as this question's answer.
      removeManyReset();
      open({ kind: "removeCopies", entryIds }, focusedElement());
    },
    [rows, removeManyMutate, removeManyReset, open],
  );

  /**
   * The card menu's handlers, built here rather than beside {@link menuDeps} because two of the
   * four ask {@link countEditable}, which the folder census further up the page has to state
   * first — the same temporal dead zone {@link stepperByTile} records.
   *
   * A row's deps carry `removeCopies` when its own copies are {@link countEditable}. The item list
   * is a **thunk** inside `menu`, so a list of a thousand pays for nothing until a reader actually
   * right-clicks one of them.
   */
  const rowDeps = useCallback(
    (row: CollectionRow): CardMenuDeps =>
      countEditable(row.folderId) ? { ...menuDeps, removeCopies } : menuDeps,
    [countEditable, menuDeps, removeCopies],
  );
  const rowMenu = useCallback(
    (row: CollectionRow) => menu(() => buildCardMenu(rowTarget(row), rowDeps(row))),
    [menu, rowDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key — wired everywhere its pointer twin is,
   *  because a menu only a mouse can open is a menu half this app's readers do not have. */
  const rowMenuKey = useCallback(
    (row: CollectionRow) => menuKey(() => buildCardMenu(rowTarget(row), rowDeps(row))),
    [menuKey, rowDeps],
  );
  /**
   * A tile's deps: the picked set as targets, and `removeCopies` only when the target **and every
   * picked tile** stand for copies {@link allCountEditable} allows — the menu takes the ids of
   * both, so the fence has to be asked of both.
   */
  const tileDeps = useCallback(
    (tile: CollectionTile, picked: readonly CollectionTile[]): CardMenuDeps => {
      const editable = [tile, ...picked].every((one) =>
        allCountEditable(copiesByTile.get(one.key) ?? []),
      );
      return {
        ...menuDeps,
        ...(editable ? { removeCopies } : {}),
        picked: picked.map((one) => tileTarget(one, entryIdsOf(one))),
      };
    },
    [menuDeps, removeCopies, allCountEditable, copiesByTile, entryIdsOf],
  );
  // `flip` is the wall's word that this tile turns over (issue #844) — `CardGrid`'s `flips`.
  const tileMenu = useCallback(
    (tile: CollectionTile, picked: readonly CollectionTile[] = [], flip = false) =>
      menu(() =>
        buildCardMenu({ ...tileTarget(tile, entryIdsOf(tile)), flip }, tileDeps(tile, picked)),
      ),
    [menu, tileDeps, entryIdsOf],
  );
  const tileMenuKey = useCallback(
    (tile: CollectionTile, picked: readonly CollectionTile[] = [], flip = false) =>
      menuKey(() =>
        buildCardMenu({ ...tileTarget(tile, entryIdsOf(tile)), flip }, tileDeps(tile, picked)),
      ),
    [menuKey, tileDeps, entryIdsOf],
  );

  /** The rows the open question is about, drawn from the list rather than from the drag: the
   *  payload carries ids and folders, and a reader needs the finish, the grade and the count. */
  const pickChoices = useMemo<CopyChoice[]>(() => {
    if (picking === null) return [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return picking.entryIds.flatMap((entryId) => {
      const row = byId.get(entryId);
      // A row that has left the list under an open dialog — another surface removed it, or a
      // refetch dropped it. Left out rather than drawn as an unnamed line.
      if (row === undefined) return [];
      return [
        {
          entryId,
          finish: isFinish(row.finish) ? FINISH_LABEL[row.finish] : row.finish,
          condition: conditionLabel(row.condition),
          lang: row.lang,
          quantity: row.quantity,
          folderName: row.folderName,
          blocked: blockedReason(row, picking.folderId),
        },
      ];
    });
  }, [picking, rows, blockedReason]);

  // The list's refusal, or the counts' — the wall is laid out from the counts, so a refusal there
  // is a wall that never arrives and has to be said as surely as the list's.
  const failure = query.isError
    ? ipcError(query.error)
    : collection.countsError !== null
      ? ipcError(collection.countsError)
      : null;
  // The *latest* write on the screen, not whichever is still holding an error: with `isError` on
  // both, a refused stepper press left "Could not change your collection" on screen while the
  // reader went on to remove the row successfully — an alert about something that had already been
  // dealt with. Seen live, and the rule is `lib/writes.ts`' now rather than three lines here.
  //
  // The folder writes are in the list because they are writes this screen makes, and they share
  // the banner because they share the sentence: everything here is a change to the reader's
  // collection.
  const bannerFailure = writeFailure([
    setQuantity,
    remove,
    removeMany,
    clearRemoved,
    setFolder,
    setFolderMany,
    // The sidebar's drop, which is a write this screen makes and shares the banner for the
    // reason the folder writes do: everything here is a change to the reader's collection. The
    // `+` beside it reports for itself, inside its own popup.
    addDropped,
    folders.create,
    folders.rename,
    folders.move,
    folders.reorder,
    folders.remove,
    folders.setLocked,
  ]);
  const empty = rows.length === 0;
  // The cabinet is drawn only where there is one. In a collection nobody has filed, a lone inert
  // "Collection" under a ribbon that already says Collection is the subheading this page's own
  // `sr-only` heading exists to avoid.
  //
  // **`|| folderId !== null` is what keeps a reader from being stranded**, and it arrived with the
  // pinned section: a reader who has made no folders of their own can still be *inside* one, by
  // pressing a deck group or `Recently removed`, and the breadcrumb is the only way back out.
  // Without this clause the trail was gated on a list that folder is deliberately not in, so
  // opening a deck group closed the door behind them.
  const hasFolders = userFolders.length > 0 || folderId !== null;

  /**
   * How many copies `Recently removed` holds, from the folder summary — or `null` before it has
   * answered, {@link pinnedTotals}' own reading of a miss. **The folder's number and never the
   * list's**: `Clear…` takes every copy filed there whatever the filters are hiding, so the
   * question has to state that figure rather than the one on screen.
   */
  const removedCards =
    pinned.removed === null ? null : (pinnedTotals(pinned.removed)?.cards ?? null);
  /** Whether `Clear…` has anything to take: the summary's count once it has one, and until then
   *  whether any row is on screen at all. */
  const canClearRemoved = inRemoved && (removedCards === null ? !empty : removedCards > 0);

  /**
   * Whether **this** level can hold a new folder — the path row's **Add folder**, and a fence rather
   * than an affordance. `create_folder` calls `user_folder` on the parent and answers
   * `FOLDER_NOT_YOURS` for a deck group or `Recently removed`, so a button drawn inside either would
   * be a press whose only outcome is a sentence saying it does not work. A heading's own Add folder
   * asks the same question of its folder, and is drawn on the reader's own folders only.
   */
  const canMakeFolder = readersOwnLevel(folderId);

  /**
   * **The wall** (spec §3.1): the shelves to draw, and what each shelf holds.
   *
   * - `drawnShelves` is the hook's shelves, re-asked of `buildShelves` with the folder being named
   *   put in while Add folder is open (`draftFolder`) — it never reaches the wire.
   * - `wallShelves` hides what `visibleShelves` hides, and puts back a heading holding a naming or
   *   renaming field (`keepShelf`). **Nothing is laid out until the counts answer**: a layout drawn
   *   from no counts would put an empty box under every folder for a round trip.
   * - **During a folder drag the wall folds** (spec §3.9) — every heading shut, no cards, nothing
   *   written (`foldedForDrag`) — and {@link useFoldAnchor} keeps the carried heading under the
   *   pointer as it does. **Grid only**: `VirtualTable` keys its rows by position, so folding the
   *   table under a carried heading would remount it and end the drag.
   */
  const {
    visible: openShelves,
    counts: shelfCounts,
    filtering,
    folds,
    setMany,
    shelfFolders,
  } = collection;
  const carrying = useFoldOnFolderDrag();
  const folding = carrying && view === "grid";
  useFoldAnchor(folding);
  const addingIn = openPanel?.kind === "newFolder" ? openPanel.parentId : undefined;
  const drawnShelves = useMemo(
    () =>
      addingIn === undefined
        ? builtShelves
        : buildShelves({
            folders: [...shelfFolders, draftFolder(addingIn, lockedIds)],
            levelId: folderId,
            folds,
            filtering,
          }),
    [addingIn, builtShelves, shelfFolders, lockedIds, folderId, folds, filtering],
  );
  const holding =
    addingIn !== undefined
      ? NEW_FOLDER_SHELF
      : openPanel?.kind === "renameFolder"
        ? openPanel.folderId
        : null;
  const wallShelves = useMemo((): Shelf[] => {
    if (shelfCounts === null) return [];
    if (folding) return foldedForDrag(drawnShelves, shelfCounts, filtering);
    const shown =
      addingIn === undefined ? openShelves : visibleShelves(drawnShelves, shelfCounts, filtering);
    return keepShelf(shown, drawnShelves, holding);
  }, [shelfCounts, folding, drawnShelves, filtering, addingIn, openShelves, holding]);
  /**
   * **Where the caret goes once a folder has left its heading** — Move to folder… and Delete…
   * (the final review's C-M5). `useHeadingCaret`'s `leave` is the rule; this is the wall it is
   * asked about — which headings are drawn open, the tree's parents, and the path row.
   */
  const pathRowRef = useRef<HTMLDivElement>(null);
  const caretAfterLeaving = useCallback(
    (id: number, into?: number | null) =>
      leaveCaret({
        id,
        into,
        drawnOpen: (shelfId) =>
          openShelves.some(
            (shelf) => shelf.id === shelfId && !shelf.headless && !shelf.collapsed,
          ),
        parentOf: (folder) => treeParent.get(folder) ?? null,
        pathRowAdd: () => pathRowAddFolder(pathRowRef.current),
      }),
    [leaveCaret, openShelves, treeParent],
  );
  const moveFolderTo = useCallback(
    (id: number, parentId: number | null) => {
      const land = caretAfterLeaving(id, parentId);
      moveMutate(
        { id, parentId },
        {
          onSuccess: () => {
            setPanel(null);
            land();
          },
        },
      );
    },
    [caretAfterLeaving, moveMutate],
  );
  const deleteFolder = useCallback(
    (id: number) => {
      const land = caretAfterLeaving(id);
      removeFolderMutate(id, {
        onSuccess: () => {
          setPanel(null);
          land();
        },
      });
    },
    [caretAfterLeaving, removeFolderMutate],
  );
  /** `Clear…` and `Remove N cards…`, answered — the two strip questions whose write is a
   *  mutation of this page's rather than a folder's. Held still for the memoised panel. */
  const confirmClearRemoved = useCallback(
    () => clearRemovedMutate(undefined, { onSuccess: dismiss }),
    [clearRemovedMutate, dismiss],
  );
  const confirmRemoveCopies = useCallback(
    (entryIds: readonly number[]) =>
      removeManyMutate({ entryIds, name: null }, { onSuccess: dismiss }),
    [removeManyMutate, dismiss],
  );

  /** One section per shelf, sized by its count — none while shut (its cards were never fetched)
   *  and none for the folder being named. `CardGrid` raises a count the loaded tiles outrun. */
  const sections = useMemo<ShelfSection[]>(
    () =>
      wallShelves.map((shelf) => ({
        shelf,
        tileCount:
          shelf.collapsed || shelf.id === NEW_FOLDER_SHELF ? 0 : (shelfCounts?.get(shelf.id)?.tiles ?? 0),
      })),
    [wallShelves, shelfCounts],
  );
  /** The layout at one column — the table's rows, and the one place "does the wall draw anything"
   *  is answered for both views, since the rows other than tiles do not depend on the width. */
  const tableLayout = useMemo(() => layoutShelves(sections, 1), [sections]);
  const wallDrawn = tableLayout.rows.length > 0;

  /** Where a copy let go on a shelf goes — `canFile` / `fileCard`, the one card policy on this page,
   *  handed to every heading, empty box and the sticky bar. */
  const cardTarget = useMemo<CardTarget>(
    () => ({ canDrop: canFile, onDrop: fileCard }),
    [canFile, fileCard],
  );

  /**
   * **A heading's figures** (spec §3.2): the shelf's own counts with everything under it added
   * (`rolledUp` — Review Focus 2), and under a filter `N of M`, where `M` is the unfiltered subtree
   * from `collection_folder_summary` and `N` is the counts over the filter.
   */
  const rolled = useMemo(
    () => (shelfCounts === null ? null : rolledUp(drawnShelves, shelfCounts)),
    [drawnShelves, shelfCounts],
  );
  const totalOf = useCallback(
    (shelf: Shelf): number | null =>
      // Nothing counts Not sorted unfiltered, and a miss before the summary answers is not zero.
      shelfTotal(shelf, subtotals, folders.summaryQuery.isPending ? null : folders.summary),
    [folders.summaryQuery.isPending, subtotals, folders.summary],
  );
  const statOf = useCallback(
    (shelf: Shelf) =>
      shelf.id === NEW_FOLDER_SHELF
        ? ""
        : shelfStat({
            figures: rolled === null ? null : rolled.get(shelf.id),
            total: totalOf(shelf),
            filtering,
            currency: marketplace.currency,
          }),
    [rolled, totalOf, filtering, marketplace.currency],
  );
  /**
   * A chevron press: the new state, stored only where it moves off the kind's default.
   *
   * **Nothing while a filter is on** (the final review's C-I2 ruling). Collapse is suspended then
   * (spec §3.4) — every shelf is drawn open whatever is stored — so a press wrote a fold the reader
   * could not see, and it came back as a shut shelf the moment the filter cleared. Expand all and
   * Collapse all are held the same way below.
   */
  const toggle = useCallback(
    (shelf: Shelf) => {
      if (filtering) return;
      setFold(shelf.id, foldChange(shelf, !shelf.collapsed));
    },
    [filtering, setFold],
  );

  /**
   * One shelf's heading, wired (spec §3.2, §3.8, §6). **The reader's own folder is the only kind
   * that gets anything a press could be refused for** — Add folder, Rename, the ⋯, a folder drop
   * and a drag — because the backend refuses every one of them for a deck group and `Recently
   * removed` in words, and a folder being named is not a folder yet. Not sorted also offers Add
   * folder at the root (issue #778), using `null` as its parent, never its synthetic shelf id.
   * Not sorted and the reader's folders take a card; the app's own shelves take nothing
   * (`canFile` would refuse them anyway,
   * and a heading that armed for a drop it always refuses is a promise the next press breaks).
   */
  const headingFor = useCallback(
    (shelf: Shelf): ReactNode => {
      const folder = folderById.get(shelf.id);
      const mine = shelf.kind === "folder" && folder?.kind === "user" ? folder : null;
      const renaming =
        shelf.id === NEW_FOLDER_SHELF
          ? {
              initial: "",
              mode: "create" as const,
              pending: folders.create.isPending,
              onCommit: nameFolder,
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
        <CollectionShelfHeading
          shelf={shelf}
          stat={statOf(shelf)}
          peek={peekOf(shelf, builtShelves, shelfCounts)}
          onToggle={() => toggle(shelf)}
          // Refused in the open while a filter is on (spec §3.4): the chevron says why, and
          // `toggle` writes nothing behind it either way.
          foldPaused={filtering ? FOLD_PAUSED_REASON : undefined}
          onOpen={collection.openFolder}
          onAddFolder={
            mine
              ? () => openNewFolder(mine.id)
              : shelf.kind === "unfiled"
                ? () => openNewFolder(null, shelf.id)
                : undefined
          }
          onRename={mine ? () => openRename(mine.id) : undefined}
          renaming={renaming}
          menu={mine ? folderRowMenu(mine) : undefined}
          cards={
            shelf.id !== NEW_FOLDER_SHELF && (shelf.kind === "folder" || shelf.kind === "unfiled")
              ? cardTarget
              : undefined
          }
          folders={
            mine
              ? {
                  canDrop: (drag, edge) => canPlaceFolder(drag, mine.id, edge),
                  onDrop: (drag, edge) => placeFolder(drag, mine.id, edge),
                }
              : undefined
          }
          dragFolder={mine ?? undefined}
          caret={caretFor(shelf.id)}
        />
      );
    },
    [
      caretFor,
      folderById,
      folders.create.isPending,
      folders.rename.isPending,
      nameFolder,
      dismiss,
      cancelNewFolder,
      openPanel,
      statOf,
      builtShelves,
      shelfCounts,
      toggle,
      filtering,
      collection.openFolder,
      openNewFolder,
      openRename,
      folderRowMenu,
      cardTarget,
      canPlaceFolder,
      placeFolder,
    ],
  );
  const renderLabel = useCallback(
    (group: "decks" | "managed") => <ShelfLabel group={group} />,
    [],
  );
  const renderEmpty = useCallback(
    (shelf: Shelf) => <CollectionEmptyShelf shelf={shelf} cards={cardTarget} />,
    [cardTarget],
  );
  const renderSticky = useCallback(
    (shelf: Shelf | null, scrollToTop: () => void) => (
      <CollectionShelfSticky
        shelf={shelf}
        onOpen={collection.openFolder}
        // **No `Top` on the shelf bar while the filter quick bar is down** (spec §6.2): the quick
        // bar leads with its own `Top`, pinned directly above this one, and two buttons with one
        // name and one job stacked 53px apart is a screen asking the reader which to press.
        // Withholding the handler rather than hiding the button is the whole mechanism —
        // `ShelfStickyBar` draws no `Top` at all without `onTop`, so nothing is left in the tab
        // order or the accessibility tree. The quick bar's is the one to keep because it does
        // more: it also puts the caret back in the page's search field. The table never gets
        // here with `quick.shown` true — the hook is disabled outside grid view.
        onTop={quick.shown ? undefined : scrollToTop}
        cards={cardTarget}
      />
    ),
    [collection.openFolder, cardTarget, quick.shown],
  );
  /**
   * The heading each view brings into view — the grid's `revealShelfId` and the table's, one answer.
   * Add folder's placeholder heading while its field is open, so the name field is never below the
   * fold of a long wall; and once it closes, or once a Move up / Move down has landed, the heading
   * the caret goes back to (`caretDue`).
   */
  const revealShelfId = addingIn !== undefined ? NEW_FOLDER_SHELF : (caretDue?.shelfId ?? null);
  const gridSections = useMemo<GridSections<CollectionTile>>(
    () => ({
      sections,
      tilesOf,
      renderHeading: headingFor,
      renderEmpty,
      renderLabel,
      renderSticky,
      revealShelfId,
    }),
    [sections, tilesOf, headingFor, renderEmpty, renderLabel, renderSticky, revealShelfId],
  );
  /**
   * The table's half. `layout`, `rowsOf` and `complete` are what its rows are built from and each
   * holds still across a render that changes no data; the drawings change with every render
   * (`headingFor` closes over this page's mutations, and a `useMutation` result is new each time),
   * which is why `CollectionTable` keys its rows on those three and never on this object.
   *
   * **Since issue #557 the drawings hold still too**: `headingFor` and everything under it close
   * over the writes' `mutate`, `reset` and `isPending` rather than the result objects, so across a
   * render that changes no data this object is the same one and the memoised table is not rendered
   * at all. The table's keying on the three is kept — it is still what is right for a render that
   * does change a drawing (a heading's figures) without changing a row.
   */
  // The list on screen's own answer, never `query.hasNextPage`: that is the level asked for, and
  // while the previous level is still drawn the two are different lists.
  const complete = collection.listComplete;
  const tableShelves = useMemo<CollectionTableShelves>(
    () => ({
      layout: tableLayout.rows,
      rowsOf,
      complete,
      renderHeading: headingFor,
      renderLabel,
      renderEmpty,
      renderSticky,
      revealShelfId,
    }),
    [tableLayout, rowsOf, complete, headingFor, renderLabel, renderEmpty, renderSticky, revealShelfId],
  );
  const caption = useMemo(() => lockedCaption(lockedIds), [lockedIds]);
  /**
   * The wall's other three slots, held still for the memoised wall (issue #557) — each is argued
   * at its prop below, and was an arrow written there until a fresh one per render was what made a
   * keystroke draw every tile again.
   */
  const { currency } = marketplace;
  const tileMoney = useCallback(
    (tile: CollectionTile) => formatPrice(tile.unitPrice, currency),
    [currency],
  );
  const selectTile = useCallback(
    (cardId: string, tile: CollectionTile) => openCardAsFinish(cardId, tile.finish),
    [openCardAsFinish],
  );
  const tileColumn = useCallback(
    (tile: CollectionTile) => {
      const step = stepperByTile.get(tile.key);
      if (step === undefined) return null;
      // The mark the art is drawing, read through the same function the chip above it
      // takes — so a plain tile is announced "Copies of Black Lotus" and never
      // "(Nonfoil)", which is the wall's own rule stated in words instead of in a sheen.
      const mark = finishMarkOf(tile);
      return (
        // **`data-no-drag` is load-bearing and must not be dropped.** `NOT_A_DRAG`
        // (`dnd.ts`) is `"[data-no-drag], input, select, textarea"`, so the stepper's
        // `<input>` is excluded by tag and its two `<button>`s are not — and the whole
        // tile is a drag source. Without this mark a press on `−` plus five pixels of
        // travel is a drag of the card, and the press is never delivered as a click.
        // `cardDraggable` asks `closest()`, so one mark on the wrapper covers both
        // buttons; `DeckCardControls` carries the identical mark for the identical
        // reason.
        <span data-no-drag="" className="flex">
          <QuantityStepper
            // The deck stack's column, verbatim — the 36px box, standing on end, over
            // art. `xs` and `card` are the two sizes drawn on a card face and both
            // follow the reader's zoom through `--control-scale`; this is the larger.
            // Against a 170px tile whose art box is 238px (5:7) the column rests at
            // 30.6 × ~98.6px — 18% of the width and 41% of the height, starting 24px
            // down — where on the deck's own 210 × 293 card it is 15% and 34%. Both are
            // constants across the zoom ladder rather than readings at 1×, because the
            // tile, the art and the column are each linear in the same zoom.
            size="card"
            orientation="vertical"
            // Drawn over an illustration, and inside a box that clips its own corners —
            // the deck stepper's two reasons, unchanged one surface over.
            tone="art"
            focus="inset"
            // **The tile's sum, never the addressed row's own number.** `OwnedBadge`
            // draws that same figure in the tile's other corner, and two numbers on one
            // piece of art disagreeing about how many copies it stands for is not a
            // state this wall may show. (They were six pixels apart while this rode in
            // the bottom strip; the column has moved and the rule has not, because what
            // makes it one is the tile rather than the distance.)
            value={tile.copies}
            // The copies this control cannot reach — see {@link stepperByTile}, where
            // the arithmetic and the two behaviours that fall out of it are worked
            // through. `0` on the ordinary single-entry tile, so zero deletes the entry
            // exactly as the table's stepper does.
            min={step.floor}
            // **Name the object, not the control** — and the object is a *printing in a
            // finish*, which is the whole of this wall's grain, so the name has to carry
            // both or it is not a name.
            //
            // **The set and number are not decoration here, and a live pass is what
            // proved it.** Driven in the browser (2026-09-01, Storybook's
            // `SteppingFromTheWall` at 170px), the seed put three Lightning Bolt tiles on
            // one screen — 2X2 ×4, LEA ×1 and an etched STA — and with the printing left
            // out the first two both announced `Copies of Lightning Bolt`. A collection
            // holds several printings of one card as a matter of course, far more often
            // than a wishlist does, so that is the ordinary case rather than a corner:
            // two controls with one name, on a surface where the only other thing
            // distinguishing them is a picture. jsdom cannot referee it — both names are
            // *correct*, they are merely not *unique*, and no assertion about one tile
            // can see the other.
            //
            // {@link wishLabel}'s grammar exactly — `Name (SET 123)`, with the finish
            // folded into the same bracket — because the wishlist's wall stands one tab
            // away and reached this conclusion first. The chin under the art already
            // draws `SET · number`, so the name says what the tile shows.
            //
            // The finish rides it **only where the tile wears a mark**: a plain copy
            // draws no chip ({@link finishMarkOf}), so announcing `(Nonfoil)` would be
            // the wall's own rule contradicted in words six pixels from where it is
            // being obeyed in pixels.
            label={
              `Copies of ${tile.name} ` +
              `(${tile.setCode.toUpperCase()} ${tile.collectorNumber}` +
              `${mark === null ? "" : `, ${finishLabel(mark)}`})`
            }
            // **A delta applied to the addressed row**, because the control shows a sum
            // and the write moves one entry: the reader asked for one more copy of this
            // *object*, and the row this tile addresses is where that copy goes.
            onChange={(next) => onSetQuantity(step.row, step.row.quantity + (next - tile.copies))}
          />
        </span>
      );
    },
    [stepperByTile, onSetQuantity],
  );

  /**
   * What the export dialog's two sentences have to say about where the reader is standing.
   *
   * **Export sends the wall's `shelves` on purpose** — `useCollection` puts every shelf at and
   * below the level on `filters`, collapsed ones included, and the sweep reads that object — so an
   * export is what the wall covers. At the root that is every card, so there is no filing to widen
   * past and no folders clause; standing in a drawer, it is that drawer and everything under it, and
   * the dialog says so. `everythingFilters` strips `shelves` with the rest.
   */
  const exportFiling = {
    folder: folderId !== null ? folderNameOf(folderId) : null,
    narrows: folderId !== null,
  };
  const status = statusOf(collection, failure, {
    drawn: wallDrawn,
    inFolder: folderId !== null,
  });

  return (
    <section
      className={cn(
        "flex flex-col gap-3",
        // **`h-full` is the table's, not the page's** — `SearchPage`'s branch, and the wishlist
        // carries the twin of this comment. `VirtualTable` is `min-h-0 flex-1 overflow-auto`, so it
        // has a height only while every box above it has one, and this section pinned to `main`'s
        // height is the top of that chain: without it the table collapses to nothing.
        //
        // The wall wants the opposite. Under `CardGrid`'s `grow` it is as tall as its rows and
        // `main` is what scrolls them, and a section clamped to one screen would be a containing
        // block one screen tall — which is as far as the dock's `sticky` could then travel, so
        // the search column would unstick and scroll away after the first viewport of cards.
        view === "table" && "h-full",
      )}
    >
      {/* **The filter quick bar** (spec 2026-09-29, §6.2) — the page row's filters in one row,
          docked at the top of `main` once the `FilterBar` below has scrolled out of view.

          **The section's first child**, above the figures band: it is a `sticky top-0 h-0`
          wrapper, and a sticky box can travel only as far as its containing block, so it has to
          sit in the section that is as tall as the wall rather than in any row inside it. `-mb-3`
          is this section's `gap-3` handed back, so a wrapper of no height costs the page no
          height either.

          **It takes exactly what the page's `FilterBar` takes** — the same `search` (this page's
          `useCollection`, so a chip pressed in the bar and one pressed on the page are one state),
          `labels`, `sortRows` and `tray` — so it can never offer a filter the page row does not.
          `shown` is `useFilterQuickBar`'s answer, which is always false in table view. */}
      <FilterQuickBar
        search={collection}
        shown={quick.shown}
        labels={COLLECTION_LABELS}
        sortRows={collection.sortRows}
        tray={COLLECTION_TRAY}
        className="-mb-3"
      />

      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel
          "Collection" 18px under it would be a subheading repeating its own heading. The
          header below says what this view is far better than a title would. */}
      <h2 className="sr-only">Collection</h2>

      <CollectionSummaryHeader
        summary={figures}
        marketplace={marketplace}
        // The band's far end, where they used to sit beside the filter row — see `FigureRow`,
        // which is where the placement is argued. The names say *what* is moved, because both
        // dialogs carry a control called `Import` and two of those on one screen is a pair a
        // screen reader can only tell apart by position.
        actions={
          // Two bordered groups on one line — sharing, then transfer. `items-start` rather than
          // `items-center`: the Share group carries a status line under it that grows and
          // shrinks, and centring would lift the transfer pair off the row every time it said
          // something. `flex-wrap` is what puts them on two lines rather than out of the window
          // when the row is short, and it is inert unless `FigureRow`'s actions box can be
          // squeezed — see that file, where the `shrink-0` that made this wrap unreachable is
          // recorded with the measurement that found it.
          <div className="flex flex-wrap items-start justify-end gap-2">
            <ShareFolderMenu target={shareTarget} />
            <ImportExportPair
              onImport={() =>
                setImporting({
                  // The drawer on screen, when it is one of the reader's own; a deck's group and
                  // `Recently removed` are no place for a file to land.
                  folderId:
                    folderId !== null && userFolders.some((folder) => folder.id === folderId)
                      ? folderId
                      : null,
                  fromMenu: false,
                })
              }
              onExport={() => {
                setExportFolder(null);
                setExporting(true);
              }}
              importLabel="Import cards"
              exportLabel="Export collection"
            />
          </div>
        }
      />

      {/* The region is mounted for the life of the view and the banner is swapped into it: a
          live region that appears together with its own text announces nothing, because there
          was no change for a screen reader to notice — the same rule as the status line below
          and as the quick-add's report. `empty:-mt-3` gives back the flex gap it would
          otherwise hold open under the header while it is saying nothing at all. */}
      <div role="status" aria-label="Needs review" className="empty:-mt-3">
        {/* Only while there are flagged rows *and* the reader is not already looking at them —
            with the filter on, the list is the answer and the banner would be a second copy of
            the question.

            `!== true`, not `!`: the chip has three states, and `false` is "the rows nothing
            flagged". Under a falsy test that state would put the banner back on screen above
            a list showing precisely the rows nothing is wrong with, offering to show them. */}
        {collection.needsReview !== true && (figures?.needsReview ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface px-3 py-2 text-xs">
            <span className="min-w-0">
              <span className="mr-1 font-medium text-destructive">Needs review:</span>
              <span className="font-mono tabular-nums">{figures?.needsReview}</span>{" "}
              {figures?.needsReview === 1 ? "entry" : "entries"} with a printing that changed or
              was removed.
            </span>
            <button
              type="button"
              onClick={() => collection.setNeedsReview(true)}
              className={cn(
                "ml-auto shrink-0 rounded-md border border-accent px-2 py-1 text-accent",
                "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
                FOCUS,
                "motion-reduce:transition-none",
              )}
            >
              Show them
            </button>
          </div>
        )}
      </div>

      {/* The same row the search and the Tags page draw, over this page's own hook — see
          `FilterBar`, whose prop is a structural `FilterSurface` that `useCollection` satisfies.
          What was a bespoke two-line row of fourteen controls is the shared four-on-the-bar plus a
          tray, so a reader who has learned that row once does not have to learn it again here. */}
      <FilterBar
        // The block the filter quick bar watches: once all of it — the row, an open tray and the
        // stated line — is above `main`'s top, the quick bar comes down. A callback ref into
        // state, so the observer is rebuilt if this block remounts (see `filterRow`).
        rootRef={setFilterRow}
        search={collection}
        labels={COLLECTION_LABELS}
        sortRows={collection.sortRows}
        tray={COLLECTION_TRAY}
        layoutFor="collection"
        // The chips are stated in the path row instead — see `StatedFiltersLine` there.
        statesFilters={false}
      />

      {/* **The row the list and the search column share** (design §4), and the one thing on this
          page that had to move to make room for a sidebar: everything above stays full width,
          because the figures band is a band and `FilterBar` lays itself out in four `@container/fb`
          bands at 640/900/1500 — taking width off that row rearranges the bar rather than merely
          shortening it.

          `min-h-0` so the column inside can be squeezed below its content and take the scroll,
          which is what it did as this element's own class before the row existed — **and since
          2026-09-08 that is the table's arrangement alone**, for the reason on the branch below. */}
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
          // header. `sticky` (at `quick.dockTop`) does the pinning in both.
          view === "table" && "min-h-0 flex-1",
        )}
      >
        {/* **`min-w-0` is not optional.** A flex item cannot shrink below its own min-content, and
            an overhang inside `AppShell`'s `overflow-auto` `main` becomes a horizontal scrollbar
            across the whole page — the 1024px-floor failure `ManaValueChips` already shipped once.
            Everything else here is what this box has always carried. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* **The path row** (spec §3.5): where the reader is standing on the left, what they can
              do to the shelves below on the right. Navigation and shelf controls both, which is why
              neither is among the filters — Reset all undoes neither, and a control in that row
              Reset all could not undo would be the one thing in it that lies.

              The breadcrumb is drawn wherever there is a cabinet to speak of — a lone `Collection`
              under a ribbon that says Collection is not one — and **its segments are the only place
              a folder can be dropped besides a heading**: a heading's lead segments and the sticky
              bar's are buttons only. `Clear…` joins the row inside `Recently removed` (issue #506),
              by the summary's count, so a filter that hides every row does not hide the control
              that would clear them. The toolbar is always drawn: Expand all and Collapse all mean
              something at every level, and Add folder is drawn where the level can hold one. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {hasFolders && (
              <div className="min-w-0">
                <CollectionBreadcrumb
                  trail={trail}
                  onOpen={collection.openFolder}
                  canDrop={canFile}
                  onDropCard={fileCard}
                  canDropFolder={canPlaceOnLevel}
                  onDropFolder={placeOnLevel}
                />
              </div>
            )}
            {/* **The page's one live region, and it lives in this row rather than on a line of its
                own under it** (2026-09-27, the header redesign). A region that appears together
                with its text announces nothing, so it is mounted for the life of the view.

                It had a `min-h-4` line of its own until then, reserved whether or not it said
                anything, for the final re-check's new 2: `Updating…` came and went for 40–80 ms
                after every write, and a line that is nothing tall while it is empty pushed the
                wall down 16px for exactly the frames a reveal or a drop anchor was measured
                across. That guarantee is kept and the 24px it cost (the line and its gap) are
                not: this row is the toolbar's 28px whatever the region says, `truncate` keeps a
                long sentence on its one line, and `flex-1` with a zero basis never asks the row to
                wrap. So the wall's offset still never depends on what it says.

                **The empty wall's sentence is this same element**, never a second copy: it takes
                `order-last basis-full`, which wraps it onto a whole line of its own under the
                toolbar, and draws it large and centred where the wall would be. One element, so
                the region is never remounted with its text and the sentence is never in the page
                twice. */}
            {/* The filters that are on, as chips, on this row's empty left side rather than on a
                line of their own under the bar — so filtering costs the wall no height and the
                first filter no longer moves it (2026-09-27). `basis-0` so the line never makes
                the row wrap; it scrolls sideways instead. `grow-[3]` against the status line's 1,
                so the chips get most of the room and the status sits by the toolbar. */}
            <StatedFiltersLine search={collection} className="grow-[3] basis-0" />
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
            <div ref={pathRowRef} className="ml-auto flex shrink-0 items-center gap-2">
              {canClearRemoved && (
                <button
                  type="button"
                  onClick={(e) => {
                    clearRemoved.reset();
                    open({ kind: "clearRemoved" }, e.currentTarget);
                  }}
                  aria-expanded={openPanel?.kind === "clearRemoved"}
                  className={CONFIRM_CANCEL}
                >
                  Clear…
                </button>
              )}
              <ShelfToolbar
                onAddFolder={canMakeFolder ? () => openNewFolder(folderId) : undefined}
                // Held while filtering, the chevron's rule: every shelf is drawn open then, so a
                // press would store folds the reader cannot see. `foldPaused` says so on both
                // buttons; the guards below are the page's own half, kept behind it.
                foldPaused={filtering ? FOLD_PAUSED_REASON : undefined}
                onExpandAll={() => {
                  if (!filtering) setMany(foldAll(builtShelves, false));
                }}
                onCollapseAll={() => {
                  if (!filtering) setMany(foldAll(builtShelves, true));
                }}
              />
            </div>
          </div>

          {/* The strip of folder questions — `CollectionFolderPanel`, where why it is a strip above
              the wall rather than a popup on its heading is argued. */}
          {(openPanel?.kind === "moveFolder" ||
            openPanel?.kind === "deleteFolder" ||
            openPanel?.kind === "clearRemoved" ||
            openPanel?.kind === "removeCopies") && (
            <CollectionFolderPanel
              panel={openPanel}
              nodes={nodes}
              userFolders={userFolders}
              rows={rows}
              removedCards={removedCards}
              folderNameOf={folderNameOf}
              movePending={folders.move.isPending}
              removePending={folders.remove.isPending}
              clearPending={clearRemoved.isPending}
              removeManyPending={removeMany.isPending}
              onMoveFolder={moveFolderTo}
              onDeleteFolder={deleteFolder}
              onClearRemoved={confirmClearRemoved}
              onRemoveCopies={confirmRemoveCopies}
              onCancel={dismiss}
              onClose={close}
            />
          )}

          {/**
           * **The one gesture a lock slows down**, issue #365 and design §5 — a copy dragged into a
           * drawer the reader set aside, or out of one, asked about before it moves.
           *
           * **Above the wall rather than under the tile it was asked from**, which is the
           * `CollectionSearchTab` question's own placement and for its reason one surface over: the
           * grid virtualises, so a tile scrolled out from under an open question would unmount it
           * mid-answer — and a box drawn *into* the wall would reflow the row of drawers around the
           * card the reader is aiming at. It survives the position by naming the card and the drawer
           * in words, so the question never depended on remembering which tile the drag started on.
           *
           * `statusLine` and `overflow-hidden`, the failure banner's own grow-in: this column is a
           * stack of rows, so anything appearing in it pushes everything below it down together, and
           * a box with its own padding can never animate shorter than that padding.
           */}
          <AnimatePresence initial={false}>
            {crossing && (
              <motion.div {...statusLine} className="shrink-0 overflow-hidden">
                <LockedMoveConfirm
                  move={crossing}
                  onConfirm={() => {
                    commitFile(crossing.drop, crossing.to);
                    setCrossing(null);
                  }}
                  onCancel={() => setCrossing(null)}
                />
              </motion.div>
            )}
          </AnimatePresence>

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
                  Couldn't change your collection — {bannerFailure}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* The last bulk write, offered back (issue #555) — an import, a `Remove N cards…`, a
              `Move N cards to`. Under the failure banner because the two are the page's two
              sentences about something the reader just did, the refusal first; always mounted,
              so the sentence arriving in it is announced. `empty:-mt-2` gives back this
              column's gap while it says nothing, the *Needs review* region's arrangement. */}
          <UndoNotice scope="collection" className="empty:-mt-2" />

          {/* A write the right-click menu started and the backend refused, beside the banner
              above rather than folded into it: that one is about this list's own controls — a
              stepper press, a removal — and this one is about a card the reader filed somewhere
              from a menu that has already closed. */}
          <CardMenuRefusal error={menuFailure} />

          {wallDrawn &&
            (view === "grid" ? (
              <CollectionCardGrid
                rows={tiles}
                // **Shelves** (spec §3.1): one section per shelf, each drawn under its heading, the
                // app's own under Decks — `rows` is still what the selection and the walk run over.
                sections={gridSections}
                label="Your collection"
                listKey={collection.scrollKey}
                // **This wall grows and `main` scrolls it — the page is one long page.** The search
                // page said it first (2026-09-03) and the wishlist takes the same change in this
                // commit: bounded, the wall was whatever height the desk row had left after the
                // figures band, the filter bar and the path row, so a binder was read through a
                // letterbox with a scrollbar of its own an inch from the page's — and nothing on
                // screen said which one a wheel would turn.
                grow
                // **The shelf bar stacks flush under the filter quick bar** (spec §6.2): 53 while
                // the bar is down, 0 while it is up. `CardGrid` adds it to the sticky anchor's
                // `top` and to the edge `stickyShelfAt` measures from, so the shelf bar pins at
                // the quick bar's foot rather than behind it *and* names the shelf actually under
                // it rather than one 53px further up. Grid only — the table branch below takes
                // nothing, because the quick bar never shows in table view.
                stickyTop={quick.stickyTop}
                // This wall's own zoom, kept apart from the search's: the two views are the same
                // component over different rows, and a reader who peers at one printing's art in
                // search is not asking for a binder at 2× as well. `CardGrid`'s `zoomSection`
                // carries why it is required rather than defaulted.
                zoomSection="collection"
                // **The wall is a drag source now**, through `dragRecord` rather than
                // `dragPayload`: a tile's drag means two things at once — a card, for the deck
                // categories and the sidebar's Decks entry that have always taken one from this
                // page's *table*; and the several `collection_entries` rows the wall summed into
                // one piece of art, for a heading and a breadcrumb segment. Two marks in one
                // flat record is what that slot carries, and the wishlist's tiles reached the
                // shape first. See {@link tileDrag}.
                dragRecord={tileDrag}
                // Ctrl and Shift build a set of tiles (issue #214).
                selectionScope="collection"
                // Ctrl+A is owed the whole collection, however long — `SELECT_ALL_LIMIT`.
                selectAllLimit={Infinity}
                // **The ring follows the *tile*, so `selectedId` is a composite.** Two tiles here
                // carry one card id, and the pane's `selectedCardId` alone would ring both of a
                // printing the reader opened one of. Built through {@link tileKeyOf} rather than
                // spelled out, because the tile's own key is built by the same function and two
                // spellings that drifted would be a wall where nothing rings at all.
                selectedId={
                  selectedCardId === null ? null : tileKeyOf(selectedCardId, paneFinish)
                }
                // The finish travels with the press, so the pane opens showing the object the
                // reader pointed at rather than the plain one. The tile is the second argument
                // because a tile here is a printing *and* a finish — see `CardGrid`'s `onSelect`,
                // which the other six walls ignore.
                onSelect={selectTile}
                // The same arrow-key walk the search wall takes, on the same terms: both slots
                // above reach the store the card surface reads, so a press moves the open card
                // rather than only an outline. The two walls that are a *page* pass this and the
                // two that are a panel do not — `CardGrid`'s `arrowNav` is where that split is
                // argued.
                //
                // **What the caret note is filed under is still the card**, not the tile key:
                // `CardGrid` hands `keepCaretForCard` the printing because the note is read back by
                // the card it was opened on, so a note filed under `c1:foil` would break this
                // wall's walk after exactly one step. **Nothing reads it since the docked pane was
                // deleted on 2026-09-03, and nothing needs to** — the modal is `aria-modal`, so
                // this wall takes no arrow press while a card is open, and `Dialog` focuses its
                // panel once per open rather than per card. Dormant, not broken; `caretWalk.ts`
                // carries the argument.
                arrowNav
                onNeedNextPage={onNeedNextPage}
                // The same mark search draws, and only the mark: the corner and the felt
                // behind it are the wall's, so the two views cannot drift into two shades.
                // No `wishlisted` — this wall shows what is owned and has no opinion about
                // what is wanted. A tile at zero copies draws nothing, which is the badge's
                // own guard and the reason this view no longer has a badge of its own.
                badge={ownedBadgeOf}
                // What one copy of this printing **in this finish** costs. Already on the row and
                // priced at that entry's exact finish by `collection.rs`; the wall simply never
                // drew it. `formatPrice` and never a bare `Intl.NumberFormat`, and a `null` is the
                // em dash rather than a reason to borrow another marketplace's number.
                money={tileMoney}
                // The sheen over the art and the glyph in the chin, which is the *other* half of
                // what tells a reader the two tiles of one printing apart.
                //
                // **`nonfoil` is mapped to `null`, and that is not a tidy-up** — {@link finishMarkOf}
                // is where that argument lives, and it is a named function rather than the inline
                // expression this slot held until the stepper below started announcing the same fact
                // in words.
                finish={finishMarkOf}
                // The printing, and a lock after it on a tile whose drawer is set aside (issue #436)
                // — see {@link lockedCaption}. The heading above says which drawer.
                caption={caption}
                /* **The wall's own stepper** (issue #284), standing in the tile's right margin
                   (issue #348). Until it landed this view could maintain quantities in its *table*
                   alone, which made the wall the layout a reader looked at and the table the one
                   they worked in.

                   **It rode in the bottom strip for its first two days and does not any more.** The
                   report was that neither the style nor the location matched the deck builder's, and
                   neither did: the deck stack draws a 36px column up the card's right-hand side and
                   this drew a 20px bar tucked into the bottom corner. It is the same control over
                   the same kind of object, so it is one recipe now — {@link CardGrid}'s `column`
                   slot is the position and `size="card"` the size, both of them the deck stack's,
                   and the wishlist's wall took the identical change in the same commit. It still
                   costs the wall no height: the box is absolute, so `tileHeight` is unchanged by its
                   existence, which was the strip's property and is inherited rather than re-argued.

                   **Absent is a real answer, not a fallback**: {@link stepperByTile} draws nothing
                   for a tile whose copies the reader may not step, and that is the fence rather than
                   an affordance — every rule about it is at that map's own site. */
                column={tileColumn}
                // The whole tile is the target: the art, its badge and the caption.
                cardMenu={tileMenu}
                cardMenuKey={tileMenuKey}
                // A two-sided card turns over from its tile: the flip button under the stepper
                // and the menu's "Flip card" (issue #844). The table draws no picture and has
                // neither.
                flips={rowHasBackFace}
              />
            ) : (
              <>
                <CollectionTable
                  rows={rows}
                  // The list query's own count, which is over the **open** shelves only (it sends
                  // `shelves: toFetch`) — so it is the data rows this table can draw, and a shut
                  // shelf's copies, never fetched, are not counted as rows. `VirtualTable` adds the
                  // bands it has loaded, which keeps `aria-rowcount` exact.
                  total={total}
                  listKey={collection.scrollKey}
                  sort={collection.sort}
                  onSort={collection.toggleSort}
                  onNeedNextPage={onNeedNextPage}
                  onSetQuantity={onSetQuantity}
                  onRemove={onRemove}
                  // **The same fence the wall draws, said in words** (issue #284). It is one
                  // predicate on this page rather than one per layout, because the table and the
                  // wall are two drawings of one list and a row editable in one of them and not the
                  // other is a difference no reader can account for. See {@link quantityBlocked},
                  // which carries the three sentences and why the third names no mechanism.
                  quantityBlocked={quantityBlocked}
                  rowMenu={rowMenu}
                  rowMenuKey={rowMenuKey}
                  marketplace={marketplace}
                  shelves={tableShelves}
                />
                {/* The one thing about this table a reader cannot see: **the stepper is the
                    removal**. Since schema v24 a row taken to zero is deleted rather than kept
                    (`collection::set_quantity`), and the stepper is `min={0}` — so a mis-added
                    four-copy row is got rid of by holding Decrease down, and there is no other
                    control in the table that does it. Said once, under the table, at the end of
                    the line the stepper itself lives on — not per row, where forty copies of a
                    sentence about a rare action would be louder than the rows. */}
                <p className="text-right text-[0.7rem] text-dim">
                  To remove an entry, set its copies to zero.
                </p>
              </>
            ))}

          {/* **Spec §5: a price is never shown without saying how old it is** — and, with five
              marketplaces in the picker, whose it is. `pricesAsOf` answers both, and names which of
              the two clocks this marketplace runs on: the card-data sync for the blob-backed pair,
              the last price-feed refresh for the two this app downloads itself.

              **The rule reaches this wall as of 2026-08-26**, when the tiles' chins started quoting
              what one copy costs; before that the grid drew no money at all and had nothing to date.

              **Said once, under the wall, rather than on every tile** — the argument the search
              page, the Tags page, the printings modal and the deck's docked panel all make, and the
              reason the chin's money slot is a plain string rather than a tooltip binding: forty
              tiles would be one sentence said forty times.

              **Grid only.** The table states it in the Value column's own header (`CollectionTable`'s
              `columnsFor`), so drawing it here as well would say it twice in one view. Drawn rather
              than hung on a `title`, for the reason the card pane and `TheoryDiffDialog` decided the
              same way: a hover is not a reader. */}
          {!empty && view === "grid" && (
            <p className="shrink-0 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
          )}
        </div>

        {/* **The docked search column, and the box it is pinned inside.**

            `sticky` so the search stays put while a collection taller than the window scrolls
            past it, `self-start` so the row's own `stretch` does not draw it as tall as the list,
            and `flex` so the panel inside fills whatever height {@link useDockHeight} measures for
            it.

            **`LAYER.popup` while the panel is drawn over the list, and it has to be _here_.**
            `position: sticky` always creates a stacking context, so a z-index asked for inside
            this box competes only with its own siblings — which is why the panel itself carries no
            number and this element does. What it out-ranks is real: the table view draws a sticky
            header at `LAYER.header` and a row holding an open popup at `LAYER.raised`, and both
            would paint straight through an unraised overlay. It is not applied at every width,
            because a rung nothing overlaps is a claim about an overlap that does not occur. */}
        <div
          ref={dockRef}
          className={cn(
            "sticky flex shrink-0 self-start",
            overWidth !== undefined && LAYER.popup,
          )}
          // **The dock's `top` is inline, not a `top-0` class**: it is a number the filter quick
          // bar computes — 41px (under the bar, at the deck bar's clearance) while the bar is down,
          // 0 while it is up — and `useDockHeight` above is handed the very same `quick.dockTop`,
          // so the inset and the height are one value read twice and can never disagree by a
          // frame. Two classes switched on `quick.shown` would be a second spelling of 41 that the
          // hook's argument would have to be kept in step with by hand. `DeckEditor`'s dock under
          // its undocked header bar is the same arrangement (`barClearance`, issue #577).
          style={{ top: quick.dockTop }}
        >
          <CollectionSearchPanel
            // The level the reader is standing in — a `+` files there, which is the shelf at the
            // top of the wall. Written out rather than left `undefined`: absent and `null` differ on
            // the wire, and only `null` says *the root*.
            folderId={folderId}
            // The reader's own tree, already built for the wall below. Deck groups and
            // `Recently removed` are not in it and must not be: `collection_add` files into a
            // folder the same way `set_entry_folder` moves into one, and claiming a deck's group
            // holds a copy no `deck_cards` row knows about is the thing both fences prevent.
            folderNodes={nodes}
            folderName={folderNameOf}
            roomy={roomy}
            overWidth={overWidth}
            maxWidth={maxPanelWidth}
          />
        </div>
      </div>

      {/* The question a drop or a `Move to` asks when the art stands for more than one row.
          A **centred modal** rather than an anchored panel, which is `packages/ui/CLAUDE.md`'s rule for a
          surface that is *consulted* — and here it is also the only shape both doors can use: a
          drop has no opener element to anchor to, and the menu's panel has already closed by the
          time a row's handler runs.

          Keyed on what is being asked, because `PickCopies` seeds its ticks **mount-only**: two
          drops in a row onto different folders are two questions, and a panel that kept the first
          one's ticks would answer the second with the wrong rows. */}
      <Dialog
        open={picking !== null}
        title="Which copies?"
        closeLabel="Close the copy picker"
        size="w-[30rem]"
        onDismiss={() => setPicking(null)}
        onClose={() => setPicking(null)}
      >
        {picking !== null && (
          <PickCopies
            key={`${picking.entryIds.join(",")}:${String(picking.folderId)}`}
            cardName={picking.cardName}
            destination={folderNameOf(picking.folderId) ?? ROOT_LABEL}
            copies={pickChoices}
            onConfirm={(entryIds) => {
              // **One write for the whole answer** (issue #555) — `collection_set_folder_many`,
              // one transaction and one feed row, where it was one `collection_set_folder` per
              // tick and a refusal part-way filed half of them. Each entry still **merges**
              // rather than failing when the destination already holds the same eleven-column
              // grain, so two copies of one printing landing in one drawer become one row with
              // the quantities summed, which is what happens when the reader does it by hand.
              // One tick is the single write it always was: there is nothing to batch, and no
              // offer to take back one card's filing.
              if (entryIds.length > 1) {
                setFolderMany.mutate({
                  entryIds,
                  folderId: picking.folderId,
                  destination: folderNameOf(picking.folderId) ?? ROOT_LABEL,
                });
              } else if (entryIds.length === 1) {
                setFolder.mutate({ entryId: entryIds[0], folderId: picking.folderId });
              }
              setPicking(null);
            }}
            onCancel={() => setPicking(null)}
          />
        )}
      </Dialog>

      {/* One copy's grade and what was paid for it — the row's own `Edit copy…`, and
          `ipc.collectionUpdate`'s first caller in the app.

          **`close` on both exits rather than `dismiss` on one.** Every other layer this page
          raises has an element to hand the caret back to — a heading's `⋯`, an Add folder
          button — and {@link openerRef} is holding it. A context-menu row is not an element by the
          time its handler runs, so `dismiss` here would focus whichever folder control the reader
          last used, which is worse than the landing `Dialog` gives up on its own.

          The dialog is keyed by nothing and needs to be: {@link editing} is `null` between two
          openings, so `Dialog` unmounts the body and every answer in it. */}
      <EditCopy
        target={editing}
        // The selected marketplace's money, and **only** as the fallback for a copy that carries
        // no currency of its own — the stored price never converts and never moves with this
        // setting. `EditCopy.currencyOf` is where that rule is enforced.
        currency={marketplace.currency}
        onDismiss={close}
        onClose={close}
      />

      {/* Mounted unconditionally, the same shape every other dialog in this app is — `Dialog`
          itself renders nothing while closed, and staying in the tree is what lets its scrim
          fade out instead of the whole thing vanishing the instant `exporting` flips back. */}
      <ExportDialog
        open={exporting}
        subject={exportFolder?.name ?? "your collection"}
        surface="collection"
        cards={exportScope.cards}
        suggestedFileName={exportFolder?.name ?? "collection"}
        onDismiss={() => {
          setExporting(false);
          if (exportFolder !== null) openerRef.current?.focus();
        }}
        onClose={() => setExporting(false)}
        scope={{
          label: exportFolder
            ? `${count(exportScope.total)} ${exportScope.total === 1 ? "entry" : "entries"} in ${exportFolder.name}, including subfolders`
            : scopeLabel(exportScope.total, exportScope.everything, exportFiling),
          showEverything: exportFolder === null,
          everythingLabel: everythingLabel(exportFiling),
          loading: exportScope.loading,
          everything: exportScope.everything,
          onEverything: exportScope.setEverything,
          // A sweep that failed says so in the dialog, with a way to ask again (issue #555) —
          // before it, a refused page read as the collection being smaller than it is.
          error: exportScope.error,
          onRetry: exportScope.retry,
        }}
      />

      {/* One destination — the collection itself — so no destination radios are drawn: a
          choice between one thing is not a choice. Which folder is the step's own `Import into`,
          opened on the one the entry point named. `onDone`'s message is discarded, the same
          precedent `DeckEditor` and `DecksPage` set for their own import dialogs: the numbers
          are already on screen, in the preview the reader just committed. */}
      <ImportDialog
        destinations={importDestinations}
        open={importing !== null}
        onDismiss={() => closeImport(true)}
        onClose={() => closeImport(false)}
        onDone={() => closeImport(false)}
      />
    </section>
  );
}

/**
 * The one line that says what the list area is currently showing, or nothing at all.
 *
 * **A wall of headings is content**, which is the whole of what `drawn` is for: a reader who has
 * collapsed every shelf, or who is standing in an empty folder under its dashed box, is looking at
 * the answer, and a sentence over it would be the page contradicting itself. Only a wall with
 * nothing on it at all says something — and what an empty wall means depends on where the reader
 * is standing: an empty root is a collection nobody has added to, and an empty deck group is a
 * drawer with nothing filed in it.
 */
function statusOf(
  collection: Collection,
  failure: string | null,
  { drawn, inFolder }: { drawn: boolean; inFolder: boolean },
): string {
  const { query, rows, activeCount, counts } = collection;

  if (rows.length === 0) {
    if (failure) return failure;
    if (query.isPending || counts === null) return "Loading your collection…";
    if (drawn) return "";
    if (activeCount > 0) return "No cards in your collection match these filters.";
    return inFolder
      ? "This folder is empty."
      : "Nothing here yet. Add cards from search, or import a collection file.";
  }

  // With rows on screen the headings caption the wall and the header above counts it, so the only
  // thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
