import { useCallback, useMemo, useState } from "react";
import { CollectionSummaryHeader } from "@/features/collection/CollectionSummary";
import { peekOf, rolledUp, shelfStat } from "@/features/collection/collectionShelfModel";
import {
  collectionTiles,
  shelfTotal,
  subtotalsOf,
  tilesByShelf,
} from "@/features/collection/collectionWall";
import { useCollection } from "@/features/collection/useCollection";
import { useCollectionFolders } from "@/features/collection/useCollectionFolders";
import { FOLD_PAUSED_REASON } from "@/features/shelves/ShelfToolbar";
import { useShelfFolds } from "@/features/shelves/useShelfFolds";
import { buildFolderTree, trailOf } from "@/lib/folderTree";
import { layoutShelves, type ShelfSection } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import type { WallItem } from "../CardWall";
import { collectionItem } from "../items";
import { DeckLink, EmptyShelfBox, PathRow, PhoneShelfHeading } from "../ShelfParts";
import { NO_ITEMS, ShelfWall } from "../ShelfWall";
import { DimNote, ReadError, useMore } from "./parts";

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
 * **A fold here is the phone's own and is not stored.** The shelves start from the folds the
 * reader stored on the desktop (`useShelfFolds`, read and never written), and a press here is
 * held in this page for as long as it is mounted: nothing on the phone face writes yet, and
 * `mobile:tauri` shares the desktop's database — a fold pressed on a phone must not re-fold the
 * reader's desktop.
 *
 * No filters yet: the page header has room for a `Filters` control, and the desktop hook already
 * owns every filter a sheet would set.
 */
export function CollectionPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const stored = useShelfFolds("collection").folds;
  const [pressed, setPressed] = useState<Readonly<Record<string, boolean>>>({});
  const folds = useMemo(() => ({ ...stored, ...pressed }), [stored, pressed]);

  const collection = useCollection({ folds });
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

  const toggle = useCallback(
    (shelf: Shelf) => setPressed((now) => ({ ...now, [String(shelf.id)]: !shelf.collapsed })),
    [],
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

  const pathRow =
    folderId === null ? null : (
      <div className="shrink-0 px-3">
        <PathRow root={ROOT} trail={trail} onOpen={openFolder} />
      </div>
    );

  if (query.isLoadingError) return <ReadError>Your collection could not be read.</ReadError>;
  if (countsError !== null && counts === null) {
    return (
      <>
        {pathRow}
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
        {pathRow}
        <DimNote>
          {filtering
            ? "No cards match."
            : folderId === null
              ? "Nothing in your collection yet."
              : shelves.length === 0
                ? "That folder is gone."
                : "Nothing in this folder yet."}
        </DimNote>
      </>
    );
  }

  return (
    <>
      {pathRow}
      <ShelfWall
        label="Your collection"
        sections={sections ?? []}
        itemsOf={itemsOf}
        header={
          <div className="pt-3 pb-1">
            <CollectionSummaryHeader summary={figures} marketplace={marketplace} />
          </div>
        }
        renderHeading={renderHeading}
        renderEmpty={renderEmpty}
        onOpen={onOpen}
        onNearEnd={more}
        resetKey={collection.scrollKey}
      />
    </>
  );
}
