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
import { Dialog } from "@/components/Dialog";
import type { MenuItem } from "@/components/menu/types";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { OwnedBadge } from "@/components/OwnedBadge";
import { buildCardMenu, type CardMenuDeps, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { dragData } from "@/features/decks/dnd";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { CardGrid, type GridCard } from "@/features/search/CardGrid";
import { FilterBar, type FilterLabels, type TrayCell } from "@/features/search/FilterBar";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import { everythingLabel, scopeLabel, useExportScope } from "@/features/transfer/export/scope";
import { collectionDestination } from "@/features/transfer/import/destinations/CollectionPreview";
import { ImportExportPair } from "@/features/transfer/ImportExportPair";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { CONDITION_LABEL, CONDITIONS } from "@/lib/conditions";
import { DROP_MARK_ROOM } from "@/lib/dropMarks";
import { FINISHES, FINISH_LABEL, isFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { buildFolderTree, folderDescendants, type FolderNode } from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type CollectionFolder,
  type CollectionPage as Page,
  type CollectionRow,
} from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { CollectionBreadcrumb } from "./CollectionBreadcrumb";
import { CollectionFolderCard, type CollectionFolderTotals } from "./CollectionFolderCard";
import { CollectionSummaryHeader } from "./CollectionSummary";
import { CollectionTable } from "./CollectionTable";
import {
  collectionTileDragData,
  type CollectionCopy,
  type CollectionDrop,
} from "./collectionDrag";
import { PickCopies, type CopyChoice } from "./PickCopies";
import { PinnedFolders, pinnedFolders } from "./PinnedFolders";
import { useCollection, type Collection } from "./useCollection";
import { useCollectionFolders, useSetCollectionFolder } from "./useCollectionFolders";

/**
 * What the top of the cabinet is called, in the two places this page has to say it —
 * `MoveToFolder`'s top row, and the sentence a new folder's field prints about where it will land.
 *
 * `CollectionBreadcrumb` spells its own copy of this word, because a breadcrumb that had to be
 * told what its own first segment is called would be a component that does not know what it is
 * drawing. `MoveToFolder` defaults to the deck gallery's "All decks", which is the wrong sentence
 * to show a reader filing a copy they own.
 */
const ROOT_LABEL = "Collection";

/**
 * The one dismissible layer this page can have open — the union, and never four flags.
 *
 * `DecksPage`'s `Panel` states the argument in full and it holds here for the same cabinet: a
 * half-typed folder name beside a half-answered delete question is not a state this view draws,
 * and separate booleans can express it. One value is also one Escape rung, which is the whole of
 * what {@link useDismissOnEscape} has to order.
 *
 * **No id lives in here that is not read.** `deleteFolder` carries its folder because — unlike
 * the gallery's, which asks about the folder the reader is *standing in* — this question is always
 * asked about a folder **card**, one level down from where the reader is, and there is nothing
 * else on the page holding which one.
 */
type Panel =
  | { kind: "newFolder"; parentId: number | null }
  | { kind: "renameFolder"; folderId: number }
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | null;

/**
 * A folder the summary has no row for.
 *
 * **Not a defensive default — the ordinary answer for an empty folder.**
 * `collection_folder_summary` is a `GROUP BY` over `collection_entries`, so a folder holding
 * nothing emits no row at all, and a card fed a raw `Map.get` would render `undefined` figures
 * over exactly the drawer whose whole job on this screen is to be empty. `0 cards` is the honest
 * face of an empty drawer, and an empty drawer is where the next card goes.
 *
 * **It is the answer for a folder the summary skipped, and never for a summary that has not
 * answered yet.** The two are one `Map.get` miss apart and mean opposite things — see the
 * `summaryQuery.isPending` branch at the wall below, which is what keeps them apart.
 *
 * `value` is `null` rather than `0` for `formatPrice`'s reason and the backend's own: `$0.00` is a
 * price nobody quoted.
 */
const NO_CARDS: CollectionFolderTotals = { cards: 0, value: null };

/**
 * The trail from the root down to the folder the reader is standing in — **without the root**,
 * which the breadcrumb prepends itself because `null` is a destination rather than a folder.
 *
 * Walked up through `parentId` and then reversed, because that is the only direction the flat rows
 * can be read in. Two shapes of broken input are resolved rather than trusted, and both resolve
 * **towards the root**: a `parentId` naming a folder this list does not carry — one another
 * surface deleted between the two reads — ends the walk there, so the folder draws as though it
 * sat at the top level; and a cycle, which the backend refuses outright and which only corruption
 * could produce, terminates on the visited set. That is `buildFolderTree`'s own rule applied to
 * the other half of the tree, and it is the rule because the alternative strands the reader inside
 * a folder with no way back out.
 *
 * A `folderId` naming nothing at all answers the empty trail, which is the same rule seen from the
 * bottom — the reader reads as standing at the root, which is where the cards of a deleted folder
 * have just gone.
 */
function trailOf(
  folders: readonly CollectionFolder[],
  folderId: number | null,
): readonly CollectionFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: CollectionFolder[] = [];
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
 * `collection_folder_summary` answers *direct* counts — this folder's own copies, never the ones
 * nested under it — and says so at its own type, because SQL that walked the tree would be a
 * second implementation of the arithmetic `buildFolderTree` already does for `FolderNode.count`.
 * This is that arithmetic over the two fields: a folder card handed a raw lookup would draw
 * `0 cards` over a drawer holding twelve in two sub-folders, and the reader would only catch it by
 * opening the drawer.
 *
 * **A `null` value stays `null` all the way up, and only until something under it is priced.** The
 * backend answers `None` for a folder the marketplace could price nothing in, and a sub-tree in
 * which *nothing* is priced has to say the same thing rather than `$0.00` — but a drawer holding
 * one priced card and one unpriced one is worth what the priced one is worth. So a child's `null`
 * contributes nothing and a child's number lifts the parent out of `null`, which is exactly how
 * `sum()` treats a `NULL` one statement lower down.
 *
 * The whole tree in one pass rather than a sum per card, because a node's total is its children's
 * totals and a per-card recursion would recompute every level of the cabinet once per level.
 */
function subtotalsOf(
  nodes: readonly FolderNode<CollectionFolder>[],
  direct: ReadonlyMap<number, CollectionFolderTotals>,
): ReadonlyMap<number, CollectionFolderTotals> {
  const out = new Map<number, CollectionFolderTotals>();
  const visit = (node: FolderNode<CollectionFolder>): CollectionFolderTotals => {
    const own = direct.get(node.folder.id) ?? NO_CARDS;
    let cards = own.cards;
    let value = own.value;
    for (const child of node.children) {
      const under = visit(child);
      cards += under.cards;
      if (under.value !== null) value = (value ?? 0) + under.value;
    }
    const total = { cards, value };
    out.set(node.folder.id, total);
    return total;
  };
  for (const node of nodes) visit(node);
  return out;
}

/** One tile of the wall: a card, and how many copies of it the collection holds. */
interface CollectionTile extends GridCard {
  copies: number;
  /** Carried for the right-click menu alone — nothing on the wall draws it. A menu add is
   *  filed by what the card *does*, exactly as a drag of the same card is. */
  typeLine: string | null;
  /** Also the menu's alone: which oracle card this is, so "View all printings" can reach it.
   *  `null` where the entries behind this tile are orphans. */
  oracleId: string | null;
  /**
   * The finishes the reader's own entries for this printing are in, as the JSON list
   * `CardMenuTarget.finishes` takes.
   *
   * **Not the finishes the printing exists in** — a collection row does not carry those — and
   * that difference is the point rather than a compromise. The tile sums entries, so it knows
   * exactly which finishes are behind the art in front of the reader: one, and the menu records
   * that one without asking; two, and it asks. A tile that said nothing here fell to the menu's
   * unknown-list rule and silently recorded a **nonfoil** copy for a reader who owns two foils
   * and no nonfoil, which is the failure the whole finish rule exists to prevent.
   */
  finishes: string;
}

/**
 * The entries' finishes for one printing, in the app's own order, as stored JSON.
 *
 * `FINISHES` order (nonfoil, foil, etched) rather than the order the rows arrived in: it is
 * Scryfall's, it is what every finish picker in this app reads in, and a submenu whose two rows
 * swapped places depending on which entry the backend sorted first would be a picker that moves
 * under the pointer. Unrecognised words are dropped — `finish` is TEXT with a CHECK rather than
 * an enum this side knows — and a tile left with nothing falls to the menu's unknown-list rule,
 * which is the honest answer for an entry whose finish this build cannot name.
 *
 * Every entry counts, including one emptied to zero: the wall draws a tile for it, the table
 * keeps the row with its condition and its purchase story, and it is still a finish the reader
 * has recorded holding this printing in.
 */
function ownedFinishes(seen: ReadonlySet<string>): string {
  return JSON.stringify(FINISHES.filter((finish) => seen.has(finish)));
}

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
 * printing, across finishes and across folders, and picking one of them to move would be the app
 * choosing which copy the reader meant.
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
 * Where {@link rowTarget} *names* a finish, this one offers a **list**, and the two are the same
 * rule seen from either end: a row is one entry and therefore is one finish, while a tile is a
 * card the reader may hold in two — a foil and a played nonfoil are one piece of art on this
 * wall. So the tile hands over the finishes its own entries are in ({@link ownedFinishes}), and
 * the menu does what it does on the search wall through the very same component: one finish is
 * no question, two is a submenu.
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
 * Which of `FilterBar`'s tray cells this page offers, in the order it draws them.
 *
 * The four the card search shares, then the three only a collection can ask: what the copy *is*,
 * what state it is in, and whether a sync left a question against it. The absences are each a fact
 * about the list rather than an omission — there is no **Owned** pair because every row here is a
 * copy the reader has, no **All printings** because these *are* their printings, and no **Decks**
 * because that cell is the deck editor's Collection tab and asks about one deck.
 */
const COLLECTION_TRAY: readonly TrayCell[] = [
  "set",
  "format",
  "rarity",
  "price",
  "finish",
  "condition",
  "needsReview",
];

export function CollectionPage() {
  const collection = useCollection();
  const { query, summary, rows, total, marketplace, folderId } = collection;
  const view = useAppStore((s) => s.collectionView);
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const queryClient = useQueryClient();
  const folders = useCollectionFolders();

  /**
   * Which folder layer is open, and what the caret goes back to when it closes.
   *
   * **The opener is a ref rather than a piece of `Panel`** for the reason `DecksPage` gives: the
   * three triggers here are the filter bar's `+ New folder` and, for the other two, whichever
   * folder card's `⋯` a reader happened to press, so capturing the element when the layer opens is
   * the only way one handler can serve a wall of them.
   */
  const [panel, setPanel] = useState<Panel>(null);
  const openerRef = useRef<HTMLElement | null>(null);

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
  const exportScope = useExportScope("collection", collection.filters, exporting);

  /** The import dialog. One destination, so no radio group is drawn — a choice between one
   *  thing is not a choice. */
  const [importing, setImporting] = useState(false);

  /**
   * Rewrite one entry wherever the collection is cached.
   *
   * Every cached filter combination, not just the one on screen: the same row is in the
   * "everything" list and in the "foils only" list, and a stepper press that fixed one and
   * left the other would show two different numbers for one card one filter click apart.
   */
  const patchEntry = useCallback(
    (id: number, next: ((row: CollectionRow) => CollectionRow) | null) => {
      queryClient.setQueriesData<InfiniteData<Page>>(
        { queryKey: ["collection", "list"] },
        (data) => {
          if (!data || !data.pages.some((p) => p.items.some((r) => r.id === id))) return data;
          return {
            ...data,
            pages: data.pages.map((page) =>
              next === null
                ? {
                    items: page.items.filter((r) => r.id !== id),
                    // Every page carries the same count of the whole list, so every page's
                    // copy of it moves — otherwise the header the *first* page feeds would go
                    // on counting a row that is gone.
                    total: Math.max(0, page.total - 1),
                  }
                : { ...page, items: page.items.map((r) => (r.id === id ? next(r) : r)) },
            ),
          };
        },
      );
    },
    [queryClient],
  );

  /** Undo, for a write the backend refused. */
  const snapshot = useCallback(
    () => queryClient.getQueriesData<InfiniteData<Page>>({ queryKey: ["collection", "list"] }),
    [queryClient],
  );
  const restore = useCallback(
    (saved: ReturnType<typeof snapshot>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  /**
   * What every write here has in common: the header re-fetches, the search is marked stale,
   * and the list is *not* re-fetched — the row's own number has already been rewritten from
   * the answer, and re-reading a hundred rows because one of them changed by one is a round
   * trip nobody is waiting for. A wrong total, though, is a worse lie than a slow one.
   */
  const settle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection", "summary"] });
    // And the folder subtotals, for the header's own reason one level down: `cards` is
    // `sum(quantity)` and `value` is `sum(quantity * unit_price)`, so a stepper press on a filed
    // row moves the card above it by exactly the amount it moved the header. This is the wishlist's
    // 2026-08-22 lesson stated in the collection's terms — a folder card went on saying
    // `2 wishes · $20.00` over a drawer holding one, because the argument that "the row's own
    // number is already the answer" is true about the *row* and false about everything counted
    // from it. **Neither repairs itself at the app's own `staleTime`** (`lib/query.ts`, 30s): this
    // query's observer is mounted for the life of the page, so marking it stale without a refetch
    // changes nothing.
    //
    // Named rather than folded into `["collection"]`, which would take the list with it — the
    // paragraph above is why the list is deliberately left alone here.
    void queryClient.invalidateQueries({ queryKey: ["collection", "folderSummary"] });
    // The wishlist counts this list: a wish's `ownedQuantity` is computed from
    // `collection_entries`, so a stepper press has just made every cached wish for that card
    // wrong. The same pair `AddToCollection` invalidates, for the same reason — a write here
    // is the same write it makes.
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    // And the search results, which draw `ownedQuantity` on every row now. Refetched rather
    // than merely marked — only *active* queries refetch, and while this view is on screen
    // the search is unmounted, so from here the cost is a stale mark and nothing else.
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    // And every deck. Since schema v25 a deck owns what its own group physically holds, summed
    // per oracle id, so the row this stepper just changed *is* a deck's arithmetic if it is
    // filed in a deck group — and is spare for every theory list if it is not. Either way what
    // that deck says it owns, and the shortfall its "missing to wishlist" button would buy,
    // moved without the deck being touched at all. There is nothing left to recompute: the
    // number is read off the folder at read time rather than kept in a claim table.
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  /**
   * What a refused write leaves behind, on either path.
   *
   * The whole view, not just the list: a refused write is usually a row something else
   * already removed (`GONE`), and a collection that has lost a row has also lost the copies,
   * the value and the unique count that row was part of — measured live, the header went on
   * counting a deleted entry until this reached past the table. The wishlist and the search
   * go with it for the same reason a success takes them: the copies that deletion took are
   * copies some wish counted as owned and some result row is badged with.
   */
  const settleFailure = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  const setQuantity = useMutation({
    mutationFn: ({ row, quantity }: { row: CollectionRow; quantity: number }) =>
      ipc.collectionSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends
    // the same number three times — the box is controlled by the cache, so a second press
    // before the first answer would be computed from a stale value.
    onMutate: ({ row, quantity }) => {
      const saved = snapshot();
      patchEntry(row.id, (r) => ({ ...r, quantity }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleFailure();
    },
    onSuccess: (change) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored — **or says the row is not there any more**.
      //
      // `removed` is not decoration. Since schema v24 `collection::set_quantity(id, 0)`
      // *deletes* the entry, and the stepper is `min={0}`, so one press on a single copy is a
      // delete. Read as "quantity 0" it left a ghost: the row stayed in the list, dimmed,
      // while `settle()` — which deliberately does not re-read the list — had already sent the
      // header off to count a collection the row is no longer in, so the two disagreed on
      // screen instantly, and the next `+` on the ghost answered GONE. `remove.onSuccess`
      // below is these same two lines, and this is the same write with a different gesture.
      patchEntry(change.id, change.removed ? null : (r) => ({ ...r, quantity: change.quantity }));
      settle();
    },
  });

  const remove = useMutation({
    mutationFn: (row: CollectionRow) => ipc.collectionRemove(row.id),
    // No optimistic half, so nothing to roll back: the row is dropped from the answer rather
    // than from the press, because a removal is one click and does not have to survive being
    // held down. The failure path is the stepper's, though — a refusal here means the same
    // thing it means there, and used to mean nothing at all.
    onError: settleFailure,
    onSuccess: (change) => {
      patchEntry(change.id, null);
      settle();
    },
  });

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

  const onSetQuantity = useCallback(
    (row: CollectionRow, quantity: number) => setQuantity.mutate({ row, quantity }),
    [setQuantity],
  );
  const onRemove = useCallback((row: CollectionRow) => remove.mutate(row), [remove]);
  const onNeedNextPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
      void query.fetchNextPage();
    }
  }, [query]);

  /**
   * The wall is a wall of *cards*, where the table is a list of entries: a foil and a played
   * nonfoil of one printing are two rows to maintain and one piece of art to look at, so the
   * tile carries the copies of both.
   */
  const tiles = useMemo(() => {
    const copies = new Map<string, number>();
    // The same walk, answering the tile's second question: *which finishes* those copies are in.
    // A second pass would be a second definition of "the entries behind this printing".
    const finishes = new Map<string, Set<string>>();
    for (const row of rows) {
      copies.set(row.cardId, (copies.get(row.cardId) ?? 0) + row.quantity);
      const held = finishes.get(row.cardId) ?? new Set<string>();
      held.add(row.finish);
      finishes.set(row.cardId, held);
    }
    const seen = new Set<string>();
    const out: CollectionTile[] = [];
    for (const row of rows) {
      if (seen.has(row.cardId)) continue;
      seen.add(row.cardId);
      out.push({
        id: row.cardId,
        // A printing `cards` has forgotten still has the set and number the entry recorded,
        // and on a wall of art that is the whole of what identifies it.
        name: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
        setCode: row.setCode,
        collectorNumber: row.collectorNumber,
        rarity: row.rarity,
        copies: copies.get(row.cardId) ?? 0,
        typeLine: row.typeLine,
        oracleId: row.oracleId,
        finishes: ownedFinishes(finishes.get(row.cardId) ?? new Set()),
      });
    }
    return out;
  }, [rows]);

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
   * **Built from the loaded, filtered rows, which is exactly what the tile claims.** The tile's
   * copy count is summed from these same rows, so "what moves" and "what the picture says it is"
   * are one list by construction. A later page of the same printing is not in it — and must not
   * be: the reader is filing what is on screen.
   */
  const copiesByCard = useMemo(() => {
    const out = new Map<string, CollectionCopy[]>();
    for (const row of rows) {
      const held = out.get(row.cardId) ?? [];
      held.push({ entryId: row.id, folderId: row.folderId });
      out.set(row.cardId, held);
    }
    return out;
  }, [rows]);

  /**
   * What a wall tile carries when it is picked up — **two marks in one flat record**, which is
   * why this is `CardGrid`'s `dragRecord` and not its `dragPayload`.
   *
   * The card half is what a deck category and the sidebar's Decks entry have always taken from
   * the collection's *table* rows; the tile half is what a folder card and a breadcrumb segment
   * read. Neither reader can see the other's key, which is `collectionDrag.ts`'s whole argument.
   *
   * `null` for a printing with no loaded row — impossible while the tile is drawn from those very
   * rows, and answered rather than asserted, because `CardGrid` reads this once at attach and
   * again at `dragstart` and a `null` there is honestly "this cannot be picked up".
   *
   * Its identity moves only with {@link copiesByCard}, i.e. when the rows change — never on a
   * bare re-render, which is what `CardGrid`'s own note asks for: a fresh arrow every render
   * tears the registration down and rebuilds it on every scrolled row.
   */
  /** The rows behind one tile, as the ids a menu target carries. */
  const entryIdsOf = useCallback(
    (tile: CollectionTile) => (copiesByCard.get(tile.id) ?? []).map((copy) => copy.entryId),
    [copiesByCard],
  );

  const tileDrag = useCallback(
    (tile: CollectionTile): Record<string, unknown> | null => {
      const copies = copiesByCard.get(tile.id) ?? [];
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
    [copiesByCard],
  );

  /**
   * The question a drop asks when the tile it was given stands for more than one row, or `null`
   * while nothing is being asked — the destination travels with it, because the folder card that
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
   * one printing with the same wall and the same ring — which is exactly the merge the wall has
   * already done, name fallback for an orphaned entry included. Feeding it `rows` would rely on
   * `listWalkStops`' own de-duplication to arrive back at this list, which is two definitions of
   * one thing and only one of them carries the fallback name.
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

  const { menu, menuKey, menuClick } = useContextMenu();
  const { deps: baseMenuDeps, error: menuFailure } = useCardMenuDeps();
  /**
   * The app-wide deps plus the one write only this page can offer.
   *
   * `pickCopies` is here rather than in `useCardMenuDeps` because it is a fact about *this
   * surface's targets*: a wall tile stands for several `collection_entries` rows, and no other
   * surface in the app draws a target that does. Every other page leaves it out and `moveItem`
   * files directly, exactly as it always has.
   */
  const menuDeps = useMemo<CardMenuDeps>(
    () => ({ ...baseMenuDeps, pickCopies }),
    [baseMenuDeps, pickCopies],
  );
  /** One row's handler. The item list is a **thunk** inside `menu`, so a list of a thousand
   *  pays for nothing until a reader actually right-clicks one of them. */
  const rowMenu = useCallback(
    (row: CollectionRow) => menu(() => buildCardMenu(rowTarget(row), menuDeps)),
    [menu, menuDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key — wired everywhere its pointer twin is,
   *  because a menu only a mouse can open is a menu half this app's readers do not have. */
  const rowMenuKey = useCallback(
    (row: CollectionRow) => menuKey(() => buildCardMenu(rowTarget(row), menuDeps)),
    [menuKey, menuDeps],
  );
  const tileMenu = useCallback(
    (tile: CollectionTile, picked: readonly CollectionTile[] = []) =>
      menu(() =>
        buildCardMenu(tileTarget(tile, entryIdsOf(tile)), {
          ...menuDeps,
          picked: picked.map((one) => tileTarget(one, entryIdsOf(one))),
        }),
      ),
    [menu, menuDeps, entryIdsOf],
  );
  const tileMenuKey = useCallback(
    (tile: CollectionTile, picked: readonly CollectionTile[] = []) =>
      menuKey(() =>
        buildCardMenu(tileTarget(tile, entryIdsOf(tile)), {
          ...menuDeps,
          picked: picked.map((one) => tileTarget(one, entryIdsOf(one))),
        }),
      ),
    [menuKey, menuDeps, entryIdsOf],
  );

  /**
   * The reader's own cabinet — the folders they made and named, and nothing the app owns.
   *
   * `collection_folders.kind` is one of three: `user`, the `deck` folder that stands for a deck,
   * and the single `removed` one. Only the first is a drawer the reader arranged, so only the
   * first belongs in the nestable tree they drag between and rename. **The other two render as a
   * separate pinned flat section** — {@link PinnedFolders}, which carries the whole argument for
   * why it is locked and why neither kind takes a drop. Schema v25 creates them, so that section
   * is real from this PR on; it was drawn empty for one PR and rendered nothing at all, because
   * an empty heading is a promise about a feature that has not shipped.
   *
   * The filter is on the *tree's* input alone. {@link trailOf} and `folderNameOf` below read the
   * whole list, so a copy that sits in an app-owned folder is still named honestly by the table's
   * Folder column rather than reading as unfiled — and the breadcrumb can still walk a reader out
   * of a deck group they have opened.
   */
  const userFolders = useMemo(
    () => folders.folders.filter((folder) => folder.kind === "user"),
    [folders.folders],
  );

  /** The other two kinds, split and ordered for the pinned section. */
  const pinned = useMemo(() => pinnedFolders(folders.folders), [folders.folders]);

  /**
   * The figures one pinned entry draws.
   *
   * **The summary row directly, never {@link subtotalsOf}**: that map is built by walking the
   * reader's tree, and these folders are deliberately not in it. Nothing can nest under a deck
   * group or under `Recently removed` — no command writes a `parent_id` naming one — so the
   * direct count *is* the recursive count here, and there is nothing to add up.
   *
   * `isPending` is the same window the wall above draws an em dash across, and for the same
   * reason: a `Map.get` miss means "empty" once the summary has answered and "not counted yet"
   * before it has, and `0 cards` over a deck holding sixty is a wrong number rather than a
   * spinner.
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
   * The folders filed directly at the level being drawn — nothing deeper, because a card is a door
   * into one drawer rather than a picture of the cabinet.
   *
   * Read off the *tree* rather than filtered out of the flat rows, so a folder whose parent
   * another surface deleted surfaces here at the root instead of disappearing with the parent that
   * is gone — `buildFolderTree`'s rule, and the reason this is not a one-line `filter`.
   */
  const childFolders = useMemo(() => {
    if (folderId === null) return nodes;
    const find = (
      list: readonly FolderNode<CollectionFolder>[],
    ): FolderNode<CollectionFolder> | null => {
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

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab restarts from
  // the top of the app. This is the **keyboard** way out — Escape, and each panel's own Cancel.
  // `close` below is the click-away way and is deliberately a different function: CLAUDE.md's rule
  // is that an outside click does *not* hand the caret back, because the reader is already
  // somewhere else.
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setPanel(null);
  }, []);
  const close = useCallback(() => setPanel(null), []);

  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: panel !== null });

  /**
   * One level up — **the breadcrumb's own second-to-last segment, read rather than re-derived**.
   *
   * {@link trailOf} ends with the folder the reader is standing in, so the step before it is the
   * one the breadcrumb draws as the last *pressable* segment, and an empty step is the root. That
   * is `null`, which for this cabinet is every folder rather than the copies filed nowhere
   * (`useCollection.folderId`) — so the two ways out land in the same place by construction rather
   * than by two pieces of arithmetic that happen to agree.
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
   */
  const parentFolderId = trail.length >= 2 ? trail[trail.length - 2].id : null;

  /**
   * Escape walks the reader out of a drawer — the floor rung, and the same step the breadcrumb's
   * last pressable segment takes.
   *
   * **`enabled` on `folderId !== null` is what keeps the press from being swallowed at the root.**
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
    enabled: folderId !== null,
  });

  const open = useCallback((next: NonNullable<Panel>, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setPanel(next);
  }, []);

  /**
   * `+ New folder`, from the filter bar — **inside the folder the reader is standing in**, which at
   * the root is the top level.
   *
   * `folders.create.reset()` for `DecksPage`'s reason: a refusal from the last attempt is not news
   * about this one.
   */
  const openNewFolder = useCallback(
    (opener: HTMLButtonElement) => {
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
   * hand back.
   *
   * **A new folder does not become the folder the reader is standing in**, the wishlist's call and
   * for its reason: the reader is looking at the cards they are about to file, and walking them
   * into the new empty drawer would take exactly those cards off screen and replace them with
   * `Nothing filed here yet.` The card they just made is right there to drag onto.
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
   * One folder card's three doors into one menu — a right-click, a `ContextMenu` keypress, and the
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

  /** The reader's own drawers and the app's deck groups, as sets, for the two fences in
   *  {@link canFile}. A `Set` because that question is asked once per target per drag frame. */
  const userFolderIds = useMemo(
    () => new Set(userFolders.map((folder) => folder.id)),
    [userFolders],
  );
  const deckGroupIds = useMemo(
    () => new Set(pinned.decks.map((folder) => folder.id)),
    [pinned.decks],
  );

  /**
   * Where a copy in the air may be let go — asked per target, because the answer differs per
   * target: the folder a row is already filed in refuses it and draws no ring at all, rather than
   * a ring that would write nothing and bump `updated_at`. `dropWrite`'s rule about a card dropped
   * back in its own column, one screen over.
   *
   * **Both of the other two clauses are about the deck boundary, and the drag is the only gesture
   * that can reach it by accident.**
   *
   * *The destination must be the root or a folder the reader made.* That is not this page's rule
   * but `collection_folders::set_entry_folder`'s: it calls `user_folder` on the destination and
   * refuses a deck group or `Recently removed` in words. **No gesture on this page reaches it
   * today** and that is deliberate: `PinnedFolders` registers no drop target, and the only
   * breadcrumb segment that could name a pinned folder is the last one, which is never a target.
   * It is the fence rather than the affordance — the thing that keeps the invariant local the day
   * somebody makes a pinned entry droppable "because the ring looked missing". A mutation check
   * confirmed the reachability: removing this clause fails nothing, where removing either of the
   * other two fails exactly one test each.
   *
   * *The source must not be a deck group.* **`set_entry_folder` fences this end too**
   * (`ENTRY_IN_A_DECK`, a sibling of `FOLDER_NOT_YOURS` rather than a reuse of it — that one is
   * about the destination folder, this one about the row), so what this clause buys is the
   * refusal *before* the drop rather than a sentence after it. The reason both ends exist is
   * unchanged and is why neither may be dropped: the destination would be a perfectly legal user
   * folder, so an unfenced `collection_set_folder` would move the copy **out of the deck's
   * custody without touching `deck_cards`** — the mirror image of the bug the paragraph above
   * prevents, and worse, because the deck would go on listing a card whose copies have walked
   * off. Copies leave a deck through `deck_to_collection`, which decrements the list in the same
   * transaction. `Recently removed` is deliberately not in this set, at either end: dragging
   * *out* of the holding area is the whole of what #209 asked for.
   */
  const canMoveCopy = useCallback(
    (from: number | null, to: number | null) => {
      if (from === to) return false;
      if (to !== null && !userFolderIds.has(to)) return false;
      return from === null || !deckGroupIds.has(from);
    },
    [userFolderIds, deckGroupIds],
  );
  /**
   * The same three clauses asked of whichever shape is in the air.
   *
   * **A tile is taken when *any* copy behind it could move, never only when all of them could.**
   * A printing a reader holds in two finishes, one of them already in this drawer, is the
   * ordinary case — and a folder that refused the whole tile for it would strand the copy that
   * genuinely has somewhere to go. Which of them actually moves is {@link fileCard}'s question,
   * and where more than one row is behind the art the reader answers it rather than the page.
   */
  const canFile = useCallback(
    (drop: CollectionDrop, to: number | null) =>
      drop.kind === "entry"
        ? canMoveCopy(drop.entry.folderId, to)
        : drop.tile.copies.some((copy) => canMoveCopy(copy.folderId, to)),
    [canMoveCopy],
  );
  /**
   * The write, or the question that has to come before it.
   *
   * A table row is one entry and files straight away — the gesture has already said everything
   * there is to say. A wall tile files straight away too **when it stands for a single row**,
   * which is the common case and the one where a dialog would be a press for a choice with one
   * answer. More than one row behind the art is the case the app cannot decide: the copies differ
   * in finish, condition, language and folder, the reader can see none of that on a piece of
   * card art, and choosing for them is the one answer that is always wrong for somebody.
   */
  const fileCard = useCallback(
    (drop: CollectionDrop, to: number | null) => {
      if (drop.kind === "entry") {
        setFolder.mutate({ entryId: drop.entry.entryId, folderId: to });
        return;
      }
      const { copies, name } = drop.tile;
      if (copies.length === 1) {
        setFolder.mutate({ entryId: copies[0].entryId, folderId: to });
        return;
      }
      setPicking({ cardName: name, entryIds: copies.map((copy) => copy.entryId), folderId: to });
    },
    [setFolder],
  );

  /**
   * Why one copy cannot go where the reader pointed, or `null` when it can — the sentence the
   * picker greys a row with.
   *
   * **Both refusals are the backend's, said early.** `collection_folders::set_entry_folder`
   * answers `ENTRY_IN_A_DECK` for a row sitting in a deck's group, and the wording here is that
   * sentence's job rather than a paraphrase of it: it names what to do instead, because there is
   * something to do. "Already there" is not a refusal the backend makes at all — it would write
   * the row back where it is and bump `updated_at` — and it is drawn because a row the reader
   * cannot usefully tick has to say why it is not ticked.
   */
  const blockedReason = useCallback(
    (row: CollectionRow, to: number | null): string | null => {
      if (row.folderId === to) return `Already in ${folderNameOf(to) ?? ROOT_LABEL}.`;
      if (row.folderId !== null && deckGroupIds.has(row.folderId)) {
        return `In ${row.folderName ?? "a deck"}. Cut the card from the deck to get it back.`;
      }
      return null;
    },
    [deckGroupIds, folderNameOf],
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

  const failure = query.isError ? ipcError(query.error) : null;
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
    setFolder,
    folders.create,
    folders.rename,
    folders.move,
    folders.remove,
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
  /** Whether *this level* holds drawers of its own. The status line's question, and it stays the
   *  reader's own children — the refile wall below is not this level's content. */
  const filed = childFolders.length > 0;
  /** Standing in the holding area, which is the one level whose wall is not its own children. */
  const inRemoved = pinned.removed !== null && folderId === pinned.removed.id;
  /**
   * The folders drawn over the cards at this level.
   *
   * **Inside `Recently removed` it is the reader's own top level rather than nothing**, and that
   * substitution *is* #209's feature. Nothing nests under the holding area, so its own children
   * are always empty — and a reader standing in a pile of copies that just left a deck, with no
   * drop target on screen, can sort them back only through the row menu. The wall puts their
   * binders under the pointer, so the sort is the drag it should have been.
   *
   * Not done for a **deck group**, whose cards may not be dragged out at all ({@link canFile}): a
   * wall of drawers that every ring refuses would be an invitation to a gesture that does nothing.
   */
  const wall = inRemoved ? nodes : childFolders;

  /**
   * What the export dialog's two sentences have to say about where the reader is standing.
   *
   * `folderId` is already in `collection.filters` and already in the sweep's key, so the export
   * has always been *correct* — it is the words that would not have been. Standing in `Trade
   * binder` with nothing typed, the dialog would say `12 cards matching your filters` and offer
   * "Export everything, ignoring the filters", when the only thing narrowing anything was the
   * drawer neither sentence mentioned.
   *
   * **`narrows` is "am I in a folder", which is where this parts company with the wishlist's
   * twin.** There, the top level narrows too — an absent `folderId` asks for the wishes filed
   * nowhere — so a reader at the root of a cabinet is looking at a sweep that leaves every drawer
   * out. Here an absent `folderId` is every folder (spec §8.4), so the root narrows nothing and
   * the extra clause would be about nothing.
   */
  const exportFiling = {
    folder: folderId !== null ? folderNameOf(folderId) : null,
    narrows: folderId !== null,
  };
  const status = statusOf(collection, failure, { filed, inFolder: folderId !== null });

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel
          "Collection" 18px under it would be a subheading repeating its own heading. The
          header below says what this view is far better than a title would. */}
      <h2 className="sr-only">Collection</h2>

      <CollectionSummaryHeader
        summary={summary.data}
        marketplace={marketplace}
        // The band's far end, where they used to sit beside the filter row — see `FigureRow`,
        // which is where the placement is argued. The names say *what* is moved, because both
        // dialogs carry a control called `Import` and two of those on one screen is a pair a
        // screen reader can only tell apart by position.
        actions={
          <ImportExportPair
            onImport={() => setImporting(true)}
            onExport={() => setExporting(true)}
            importLabel="Import cards"
            exportLabel="Export collection"
          />
        }
      />

      {/* The region is mounted for the life of the view and the banner is swapped into it: a
          live region that appears together with its own text announces nothing, because there
          was no change for a screen reader to notice — the same rule as the status line below
          and as the quick-add's report. `empty:-mt-4` gives back the flex gap it would
          otherwise hold open under the header while it is saying nothing at all. */}
      <div role="status" aria-label="Needs review" className="empty:-mt-4">
        {/* Only while there are flagged rows *and* the reader is not already looking at them —
            with the filter on, the list is the answer and the banner would be a second copy of
            the question.

            `!== true`, not `!`: the chip has three states, and `false` is "the rows nothing
            flagged". Under a falsy test that state would put the banner back on screen above
            a list showing precisely the rows nothing is wrong with, offering to show them. */}
        {collection.needsReview !== true && (summary.data?.needsReview ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface px-3 py-2 text-xs">
            <span className="min-w-0">
              <span className="mr-1 font-medium text-destructive">Needs review:</span>
              <span className="font-mono tabular-nums">{summary.data?.needsReview}</span>{" "}
              {summary.data?.needsReview === 1 ? "entry names" : "entries name"} a printing that
              changed or left the card database.
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
        search={collection}
        labels={COLLECTION_LABELS}
        sortRows={collection.sortRows}
        tray={COLLECTION_TRAY}
        layoutFor="collection"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* **The cabinet's own controls, and they are deliberately not in the filter row.**
            Where the reader is standing and what drawers exist are navigation rather than a
            narrowing — `useCollection.folderId` says so, and `resetAll` leaves both alone — so a
            `+ New folder` among the filters would be the one control in that row that Reset all
            could not undo. It sits with the breadcrumb and the folder cards instead, which is
            where the thing it makes appears. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {hasFolders && (
            <div className="min-w-0 flex-1">
              <CollectionBreadcrumb
                // Root-most first and **without the root**, which the breadcrumb prepends itself:
                // `null` is a destination rather than a folder, and only that component knows what
                // it calls it.
                trail={trail}
                onOpen={collection.openFolder}
                canDrop={canFile}
                onDropCard={fileCard}
              />
            </div>
          )}
          {/* Always drawn, unlike the wishlist's twin, which hides while the list is flattened:
              there is no flattened state here to hide from, and a new folder is made **inside the
              one the reader is standing in** — which at the root is the top level. */}
          <button
            type="button"
            onClick={(e) => openNewFolder(e.currentTarget)}
            className={cn(
              "ml-auto h-8 shrink-0 rounded-md border border-border px-3 text-sm hover:bg-surface",
              FOCUS,
            )}
          >
            + New folder
          </button>
        </div>

        {/* **One strip for all four folder layers, and it is not a placement decision so much as
            the only place there is.** Every other anchored layer in this app hangs off a
            `relative` wrapper around its own trigger; the two triggers here are the filter bar's
            `+ New folder` and a folder card's `⋯`, and neither component has anywhere to hang a
            panel — a card that hosted one would also clip it against the scroller below. So the
            strip sits where the thing being named or moved is: directly above the row of cards,
            under the breadcrumb that says which level they are. */}
        {panel !== null && (
          <div className="w-full max-w-sm shrink-0 rounded-lg border border-border bg-surface p-2 text-xs">
            {(panel.kind === "newFolder" || panel.kind === "renameFolder") && (
              <FolderNameField
                // Remounted between two openings, so a half-typed name never survives into the
                // next question — the field holds its own draft, and `AnchoredPopup`'s trick of
                // unmounting the body is not available to a strip that stays.
                key={
                  panel.kind === "renameFolder"
                    ? `rename-${panel.folderId}`
                    : `new-${panel.parentId ?? "root"}`
                }
                initial={panel.kind === "renameFolder" ? (folderNameOf(panel.folderId) ?? "") : ""}
                label={
                  panel.kind === "renameFolder"
                    ? `Rename ${folderNameOf(panel.folderId) ?? "folder"}`
                    : "New folder name"
                }
                where={
                  panel.kind === "newFolder"
                    ? `in ${folderNameOf(panel.parentId) ?? ROOT_LABEL}`
                    : undefined
                }
                submitLabel={panel.kind === "renameFolder" ? "Rename folder" : "Create folder"}
                pending={folders.create.isPending || folders.rename.isPending}
                onCancel={dismiss}
                onSubmit={nameFolder}
              />
            )}

            {panel.kind === "moveFolder" && (
              <MoveToFolder
                label={`Move ${folderNameOf(panel.folderId) ?? "folder"} into a folder`}
                nodes={nodes}
                currentId={userFolders.find((f) => f.id === panel.folderId)?.parentId ?? null}
                // The collection's own word for the top level. `MoveToFolder` defaults to the deck
                // gallery's, which is the surface it was written for.
                rootLabel={ROOT_LABEL}
                // A folder may not go inside itself or inside anything it holds. The backend
                // refuses it in words — `collection_folders.parent_id` cascades onto itself, so a
                // cycle is a graph SQLite would walk forever the day the folder is deleted — and
                // that refusal is a fence rather than the affordance.
                forbidden={
                  new Set([panel.folderId, ...folderDescendants(userFolders, panel.folderId)])
                }
                forbiddenReason="A folder cannot go inside itself, or inside anything it holds."
                // Drawn **into** the strip rather than as a popup of its own: the strip is the
                // layer, and a second box with its own shadow and its own z-index over it would be
                // a second Escape rung for one decision.
                inline
                pending={folders.move.isPending}
                onPick={(parentId) =>
                  folders.move.mutate({ id: panel.folderId, parentId }, { onSuccess: dismiss })
                }
                onClose={close}
              />
            )}

            {panel.kind === "deleteFolder" && (
              <DeleteFolderConfirm
                name={folderNameOf(panel.folderId) ?? "this folder"}
                pending={folders.remove.isPending}
                onConfirm={() => folders.remove.mutate(panel.folderId, { onSuccess: dismiss })}
                onCancel={dismiss}
                onClose={close}
              />
            )}
          </div>
        )}

        {/* The sentence the substitution above needs, and only where it is doing something: a wall
            of the reader's own binders drawn over a pile of copies that just left a deck is not
            self-explaining, and the gesture it is inviting is one a reader has no reason to guess
            at. Not drawn in a drawer of their own, where the wall is that drawer's contents — and
            not over an *empty* holding area, where it would be inviting a drag of nothing beside a
            line already saying there is nothing here. */}
        {inRemoved && wall.length > 0 && !empty && (
          <p className="shrink-0 text-xs text-dim">
            Drag a card onto a folder to file it back into your collection.
          </p>
        )}

        {wall.length > 0 && (
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
          <div className={cn("relative max-h-44 shrink-0 overflow-y-auto", DROP_MARK_ROOM)}>
            <ul
              aria-label="Folders"
              className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
            >
              {wall.map((node) => (
                <CollectionFolderCard
                  key={node.folder.id}
                  node={node}
                  // The recursive total, never the summary row: that one is direct per folder, and
                  // a folder holding two sub-folders of six cards each has none of its own.
                  //
                  // **`null` while the summary is still reading, and that is not the same fallback
                  // as `NO_CARDS`.** This wall is gated on the folder *list*, which is one flat
                  // `SELECT`; the figures come from a `GROUP BY` with a price expression behind
                  // it, and it answers later. Across that window a `Map.get` miss is
                  // indistinguishable from an empty drawer, so a drawer holding 240 copies would
                  // draw `0 cards` and then jump — a wrong number rather than a spinner.
                  // `isPending` is exactly the read that has never answered *for this
                  // marketplace*, which is the right span: switching marketplace is a new key, and
                  // the old currency's subtotals are not this one's to draw either.
                  summary={
                    folders.summaryQuery.isPending
                      ? null
                      : (subtotals.get(node.folder.id) ?? NO_CARDS)
                  }
                  currency={marketplace.currency}
                  onOpen={() => collection.openFolder(node.folder.id)}
                  rowMenu={folderRowMenu(node.folder)}
                  canDrop={(drag) => canFile(drag, node.folder.id)}
                  onDropCard={(drag) => fileCard(drag, node.folder.id)}
                />
              ))}
            </ul>
          </div>
        )}

        {/* **Under the reader's own cabinet, and drawn at every level.** The wall above is what
            the reader arranged and is the thing they came to this page for; this is the app's own
            record of where the rest of their copies are, and it belongs beside that rather than
            above it. Drawn at every level because *pinned* is the word the spec uses and it is
            what makes `Recently removed` reachable from three drawers down — see the component
            for the whole of what pinned, flat and locked each cost. */}
        <PinnedFolders
          decks={pinned.decks}
          removed={pinned.removed}
          totals={pinnedTotals}
          currency={marketplace.currency}
          openFolderId={folderId}
          onOpen={collection.openFolder}
        />

        {/* One live region, mounted for the life of the view: a region that appears together
            with its text announces nothing, because there was no change for a screen reader
            to notice. Empty — and therefore no taller than nothing — while the table below
            is answering for itself. */}
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
                Could not change your collection — {bannerFailure}
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
            <CardGrid
              rows={tiles}
              label="Your collection"
              listKey={collection.queryKeyString}
              // This wall's own zoom, kept apart from the search's: the two views are the same
              // component over different rows, and a reader who peers at one printing's art in
              // search is not asking for a binder at 2× as well. `CardGrid`'s `zoomSection`
              // carries why it is required rather than defaulted.
              zoomSection="collection"
              // **The wall is a drag source now**, through `dragRecord` rather than
              // `dragPayload`: a tile's drag means two things at once — a card, for the deck
              // categories and the sidebar's Decks entry that have always taken one from this
              // page's *table*; and the several `collection_entries` rows the wall summed into
              // one piece of art, for a folder card and a breadcrumb segment. Two marks in one
              // flat record is what that slot carries, and the wishlist's tiles reached the
              // shape first. See {@link tileDrag}.
              dragRecord={tileDrag}
              // Ctrl and Shift build a set of tiles (issue #214).
              selectionScope="collection"
              selectedId={selectedCardId}
              onSelect={selectCard}
              // The same arrow-key walk the search wall takes, on the same terms: `selectedId`
              // and `onSelect` here are both the store field the card pane reads, so a press
              // moves the pane rather than only an outline. The two walls that are a *page* pass
              // this and the two that are a panel do not — `CardGrid`'s `arrowNav` is where that
              // split is argued.
              arrowNav
              onNeedNextPage={onNeedNextPage}
              // The same mark search draws, and only the mark: the corner and the felt
              // behind it are the wall's, so the two views cannot drift into two shades.
              // No `wishlisted` — this wall shows what is owned and has no opinion about
              // what is wanted. A tile at zero copies draws nothing, which is the badge's
              // own guard and the reason this view no longer has a badge of its own.
              badge={(tile) => <OwnedBadge owned={tile.copies} />}
              // The whole tile is the target: the art, its badge and the caption.
              cardMenu={tileMenu}
              cardMenuKey={tileMenuKey}
            />
          ) : (
            <>
              <CollectionTable
                rows={rows}
                total={total}
                listKey={collection.queryKeyString}
                sort={collection.sort}
                onSort={collection.toggleSort}
                onNeedNextPage={onNeedNextPage}
                onSetQuantity={onSetQuantity}
                onRemove={onRemove}
                rowMenu={rowMenu}
                rowMenuKey={rowMenuKey}
                marketplace={marketplace}
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
      </div>

      {/* The question a drop or a `Move to` asks when the art stands for more than one row.
          A **centred modal** rather than an anchored panel, which is `src/CLAUDE.md`'s rule for a
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
        width="w-[30rem]"
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
              // One write per copy, the loop `cardMenu.tsx`'s multi-picked `Move to` already
              // makes: `collection_set_folder` addresses one row, and it **merges** rather than
              // failing when the destination already holds the same eleven-column grain — so two
              // copies of one printing landing in one drawer become one row with the quantities
              // summed, which is the same thing that happens when the reader does it by hand.
              for (const entryId of entryIds) {
                setFolder.mutate({ entryId, folderId: picking.folderId });
              }
              setPicking(null);
            }}
            onCancel={() => setPicking(null)}
          />
        )}
      </Dialog>

      {/* Mounted unconditionally, the same shape every other dialog in this app is — `Dialog`
          itself renders nothing while closed, and staying in the tree is what lets its scrim
          fade out instead of the whole thing vanishing the instant `exporting` flips back. */}
      <ExportDialog
        open={exporting}
        subject="your collection"
        surface="collection"
        cards={exportScope.cards}
        suggestedFileName="collection"
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

      {/* One destination — the collection itself — so no destination radios are drawn: a
          choice between one thing is not a choice. `onDone`'s message is discarded, the same
          precedent `DeckEditor` and `DecksPage` set for their own import dialogs: the numbers
          are already on screen, in the preview the reader just committed. */}
      <ImportDialog
        destinations={[collectionDestination]}
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
 * `WishlistPage`'s field in this page's room, and it keeps that field's two decided details: the
 * current name arrives **selected**, because the commonest rename replaces the word rather than
 * edits inside it; and both `focus()` and `select()` are called, in that order, because the spec
 * says `select()` only sets the selection and jsdom implements the spec — a browser that focuses
 * on select is what makes the missing call look sufficient.
 *
 * Escape's job stays the page's — this field is one arm of its `Panel`, so the page's single rung
 * already closes it and a rung of its own would be a second registration for one layer.
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
  /** The input's accessible name — "New folder name", or "Rename Trade binder". */
  label: string;
  /** "in Trade binder" / "in Collection" — where the folder will land, in words, for a reader who
   *  cannot see which level the strip is drawn over. Absent for a rename: the folder is not going
   *  anywhere. */
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
      // Clicking or tabbing away discards a half-typed name, exactly as every other layer in this
      // app discards its half-made decision — and not while the write is in flight, because a
      // control that disables itself on the press is blurred by the browser with no
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
          // A real `disabled`, not `aria-disabled`: the house rule is about controls that grey as
          // the reader types *and still have something to say*, and this one is a submit whose
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
 * **Deleting a folder does not delete the cards in it.** `delete_folder` re-files the sub-tree by
 * hand before the row goes and `collection_entries.folder_id` is `ON DELETE SET NULL` behind it,
 * so the copies surface at the root — with their condition, their purchase price and their
 * acquisition story, still owned, still counted. `collection_folders.parent_id` is
 * `ON DELETE CASCADE` **on itself**, so the folders inside *do* go. The two cascades point
 * opposite ways and the confirmation says both, in that order: the reassuring half first, because
 * the fear is what stops the press.
 *
 * One sentence rather than the deck gallery's counted pair: a folder card's own face already says
 * how many copies are in the drawer, in the recursive number this page summed for it, so a
 * confirmation repeating it would be the same figure twice with two chances to disagree.
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
        Its cards move back to your collection; folders inside it are deleted.
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
 * the third argument is for. An empty root is a collection nobody has added to and the sentence
 * names the two controls that fill it; an empty *folder* is a drawer the reader made and has not
 * filed anything in yet, and telling them how to add a card to a collection they already have is
 * answering a question they did not ask. And a level whose content is folder cards is not empty at
 * all — the cards are the content, so the line stays out of their way.
 */
function statusOf(
  collection: Collection,
  failure: string | null,
  { filed, inFolder }: { filed: boolean; inFolder: boolean },
): string {
  const { query, rows, activeCount } = collection;

  if (rows.length === 0) {
    if (failure) return failure;
    if (query.isPending) return "Reading your collection…";
    if (activeCount > 0) return "No cards in your collection match these filters.";
    // Drawers, and nothing loose beside them. The cards below are the answer to "what is here",
    // and a sentence over them would be the page contradicting itself.
    if (filed) return "";
    // Nothing filtered and nothing there: this is a statement about the collection, not
    // about the query. "No cards match" would blame the reader for a table nobody has put
    // anything in yet, and say nothing about how to — and the root's instruction would answer
    // the wrong question inside a folder they have just made.
    return inFolder
      ? "Nothing filed here yet."
      : "Nothing here yet. Add cards from search, or import a collection file.";
  }

  // With rows on screen the table captions itself and the header above counts it, so the
  // only thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
