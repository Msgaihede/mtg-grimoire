import { useCallback, useMemo, useState } from "react";
import { CollectionSummaryHeader } from "@/features/collection/CollectionSummary";
import {
  foldChange,
  peekOf,
  rolledUp,
  shelfStat,
} from "@/features/collection/collectionShelfModel";
import {
  collectionTiles,
  shelfTotal,
  subtotalsOf,
  tilesByShelf,
} from "@/features/collection/collectionWall";
import { COLLECTION_TRAY, useCollection } from "@/features/collection/useCollection";
import { useCollectionFolders } from "@/features/collection/useCollectionFolders";
import { FOLD_PAUSED_REASON } from "@/features/shelves/ShelfToolbar";
import { buildFolderTree, trailOf } from "@/lib/folderTree";
import { layoutShelves, type ShelfSection } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import { tileKeyOf } from "@/lib/tileKey";
import type { CollectionRow } from "@/lib/ipc";
import { CabinetFilters } from "../CabinetFilters";
import type { WallItem } from "../CardWall";
import { collectionItem } from "../items";
import { ReceiptBar } from "../deck/receipt";
import { CopyActions, type CopyActing } from "../lists/CopyActions";
import { useListReceipt } from "../lists/receipt";
import { DeckLink, EmptyShelfBox, PathRow, PhoneShelfHeading } from "../ShelfParts";
import { NO_ITEMS, ShelfWall } from "../ShelfWall";
import { CollectionTransfer } from "../transfer/CollectionTransfer";
import { DimNote, NextPageRefused, ReadError, useMore } from "./parts";

/** What the top of the cabinet is called — the desktop breadcrumb's word. */
const ROOT = "Collection";

/**
 * The collection's cabinet, read-only: the reader's shelves, each a heading over its cards.
 *
 * **The desktop's cabinet, drawn for a phone.** `useCollection` is the desktop page's hook, so
 * the shelves are `buildShelves`' — Not sorted, the reader's folders depth-first, then the deck
 * groups and `Recently removed` under **Decks** — and the tiles are `collectionWall.ts`'s, so two
 * rows of one printing are one tile here exactly as there. What is the phone's is the chrome: the
 * figures band scrolls away with the wall, the path row stays.
 *
 * **Every shelf opens.** A heading's press folds its shelf in place; its `→` opens the folder as a
 * level of its own — a deck's group and `Recently removed` included, which start shut.
 *
 * **A fold is stored, as on the desktop** (step 3.5b): a heading's press writes the reader's folds
 * through `useCollection`'s `setFold` — `useShelfFolds`, the one `app_meta` row both faces of this
 * install read — and only where it moves off the shelf kind's default (`foldChange`). Until 3.5b a
 * press was held by the page because nothing on the phone wrote; light-app.md §7.5b has why that
 * reason went and the other one (`mobile:tauri` sharing the desktop's database) does not hold.
 *
 * **A tile's `⋯` opens its copies' actions** (`lists/CopyActions.tsx`) — the desktop's edits to
 * one copy, as a sheet — and a press on the picture still opens the card. What the writes did is
 * said in one line at the foot of the page, or of the sheet while it is up.
 *
 * **Filtered as Search is**: the box and one `Filters` button on a line that stays put, the
 * filters that are on stated under it, and the sheet behind the button drawing the desktop bar's
 * own cells for this list (`COLLECTION_TRAY`) with its own sorts. A filter suspends folding, as on
 * the desktop: every shelf with a match is drawn open, and a heading's press says why it does not
 * fold.
 */
export function CollectionPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const collection = useCollection();
  const {
    query,
    marketplace,
    figures,
    counts,
    countsError,
    visible,
    shelves,
    filtering,
    folderId,
    openFolder,
    setFold,
  } = collection;
  const currency = marketplace.currency;

  const folders = useCollectionFolders();
  const trail = useMemo(() => trailOf(folders.folders, folderId), [folders.folders, folderId]);
  const subtotals = useMemo(
    () => subtotalsOf(buildFolderTree(folders.folders, []), folders.summary),
    [folders.folders, folders.summary],
  );
  const folderById = useMemo(
    () => new Map(folders.folders.map((folder) => [folder.id, folder])),
    [folders.folders],
  );

  const tiles = useMemo(() => collectionTiles(collection.rows), [collection.rows]);
  const itemsByShelf = useMemo(() => {
    const out = new Map<number, WallItem[]>();
    for (const [shelf, onShelf] of tilesByShelf(tiles)) {
      out.set(
        shelf,
        onShelf.map((tile) => collectionItem(tile, currency)),
      );
    }
    return out;
  }, [tiles, currency]);
  const itemsOf = useCallback(
    (shelfId: number) => itemsByShelf.get(shelfId) ?? NO_ITEMS,
    [itemsByShelf],
  );

  /** One section per shelf on the wall, sized by its count — none while shut, since a shut
   *  shelf's cards are never fetched. `null` until the counts have answered: a wall laid out from
   *  no counts would draw every shelf empty for a round trip. */
  const sections = useMemo<ShelfSection[] | null>(
    () =>
      counts === null
        ? null
        : visible.map((shelf) => ({
            shelf,
            tileCount: shelf.collapsed ? 0 : (counts.get(shelf.id)?.tiles ?? 0),
          })),
    [visible, counts],
  );
  const rolled = useMemo(
    () => (counts === null ? null : rolledUp(shelves, counts)),
    [shelves, counts],
  );

  const more = useMore(query, query.hasNextPage && !collection.levelHeld);

  // Nothing while a filter is on — the desktop's rule (its C-I2 ruling): folding is suspended
  // then, so a press would store a fold the reader cannot see take effect until the box empties.
  const toggle = useCallback(
    (shelf: Shelf) => {
      if (filtering) return;
      setFold(shelf.id, foldChange(shelf, !shelf.collapsed));
    },
    [filtering, setFold],
  );

  /** The rows behind each tile, by the tile's own key — what a tile's `⋯` addresses. */
  const rowsByTile = useMemo(() => {
    const out = new Map<string, CollectionRow[]>();
    for (const row of collection.rows) {
      const key = tileKeyOf(row.cardId, row.finish, row.folderId);
      const held = out.get(key) ?? [];
      held.push(row);
      out.set(key, held);
    }
    return out;
  }, [collection.rows]);
  const [acting, setActing] = useState<CopyActing | null>(null);
  const receipt = useListReceipt();
  const actionsFor = useCallback(
    (item: WallItem) => () => {
      const behind = rowsByTile.get(item.key) ?? [];
      // One row is the copy itself; several are a question the sheet asks first.
      const only = behind.length === 1 ? behind[0] : null;
      setActing({ tileKey: item.key, entryId: only?.id ?? null, seen: only });
    },
    [rowsByTile],
  );

  const renderHeading = useCallback(
    (shelf: Shelf) => {
      const folder = folderById.get(shelf.id);
      const stat = shelfStat({
        figures: rolled === null ? null : rolled.get(shelf.id),
        total: shelfTotal(
          shelf,
          subtotals,
          folders.summaryQuery.isPending ? null : folders.summary,
        ),
        filtering,
        currency,
      });
      const deckId = shelf.kind === "deck" ? (folder?.deckId ?? null) : null;
      return (
        <PhoneShelfHeading
          shelf={shelf}
          // `folderFace`'s spelling of a drawer set aside: the lock leads the figures.
          stat={shelf.locked ? `Locked · ${stat}` : stat}
          peek={peekOf(shelf, shelves, counts)}
          onToggle={() => toggle(shelf)}
          foldPaused={filtering ? FOLD_PAUSED_REASON : undefined}
          onOpenFolder={shelf.kind === "unfiled" ? undefined : () => openFolder(shelf.id)}
          aside={deckId === null ? undefined : <DeckLink deckId={deckId} name={shelf.name} />}
        />
      );
    },
    [
      folderById,
      rolled,
      subtotals,
      folders.summaryQuery.isPending,
      folders.summary,
      filtering,
      currency,
      shelves,
      counts,
      toggle,
      openFolder,
    ],
  );
  const renderEmpty = useCallback(
    (shelf: Shelf) => (
      <EmptyShelfBox>{shelf.headless ? "Nothing in this folder yet." : "Empty."}</EmptyShelfBox>
    ),
    [],
  );

  // The line and, standing in a folder, the way out of it — one band that stays put while the
  // wall scrolls. Drawn over every answer below, so a filter that matched nothing can be undone.
  const top = (
    <CabinetFilters
      surface={collection}
      label="Search your collection"
      tray={COLLECTION_TRAY}
      sortRows={collection.sortRows}
      total={figures?.totalCards}
      below={
        folderId === null ? undefined : <PathRow root={ROOT} trail={trail} onOpen={openFolder} />
      }
    />
  );

  // The receipt line and the sheet, drawn under every answer below: a removal that empties a shelf
  // still says what it did, and still offers it back.
  const foot = (
    <>
      {/* Muted while the sheet is up: the sheet draws the same line in its own foot. */}
      <ReceiptBar receipt={receipt} muted={acting !== null} className="shrink-0" />
      <CopyActions
        acting={acting}
        rows={collection.rows}
        folders={folders.folders}
        receipt={receipt}
        onActing={setActing}
        onClose={() => setActing(null)}
      />
    </>
  );

  if (query.isLoadingError) {
    return (
      <>
        {top}
        <ReadError>Your collection could not be read.</ReadError>
      </>
    );
  }
  if (countsError !== null && counts === null) {
    return (
      <>
        {top}
        <ReadError>Your collection's shelves could not be read.</ReadError>
      </>
    );
  }

  // Nothing to draw — said only once the counts have answered, because before then no sentence
  // is known to be true.
  const nothing = sections !== null && layoutShelves(sections, 1).rows.length === 0;
  if (nothing) {
    return (
      <>
        {top}
        <DimNote>
          {filtering
            ? "No cards match."
            : folderId === null
              ? "Nothing in your collection yet."
              : shelves.length === 0
                ? "That folder is gone."
                : "Nothing in this folder yet."}
        </DimNote>
        {foot}
      </>
    );
  }

  return (
    <>
      {top}
      <ShelfWall
        label="Your collection"
        sections={sections ?? []}
        itemsOf={itemsOf}
        header={
          <div className="pt-3 pb-1">
            <CollectionSummaryHeader summary={figures} marketplace={marketplace} />
            {/* Import and export, beside the figures they change — the desktop's two entries.
                The export sweeps what this wall covers: the hook's own `filters`, shelves at and
                below the level included, and inside a folder it says which one (the desktop
                page's `exportFiling`, word for word). */}
            <div className="pt-3">
              <CollectionTransfer
                filters={collection.filters}
                filing={{
                  folder: folderId === null ? null : (folderById.get(folderId)?.name ?? null),
                  narrows: folderId !== null,
                }}
              />
            </div>
            {/* The shelves still say what they hold; it is the whole-level figures that are
                missing, and an em dash for ever would say nothing about why. */}
            {collection.figuresRefused && (
              <p role="alert" className="pt-2 text-sm text-destructive">
                Your collection's figures could not be read.
              </p>
            )}
          </div>
        }
        renderHeading={renderHeading}
        renderEmpty={renderEmpty}
        onOpen={onOpen}
        actionsFor={actionsFor}
        onNearEnd={more}
        resetKey={collection.scrollKey}
        footer={<NextPageRefused query={query} />}
      />
      {foot}
    </>
  );
}
