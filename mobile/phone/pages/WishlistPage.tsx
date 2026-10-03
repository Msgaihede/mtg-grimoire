import { useCallback, useMemo, useState } from "react";
import { useDecks } from "@/features/decks/useDecks";
import { FOLD_PAUSED_REASON } from "@/features/shelves/ShelfToolbar";
import { useShelfFolds } from "@/features/shelves/useShelfFolds";
import { ManagedFolderNote } from "@/features/wishlist/ManagedFolderNote";
import { managedEmptySentence } from "@/features/wishlist/managed";
import { useWishlist, WISHLIST_TRAY } from "@/features/wishlist/useWishlist";
import { useWishlistFolders } from "@/features/wishlist/useWishlistFolders";
import { WishlistSummaryHeader } from "@/features/wishlist/WishlistSummary";
import {
  countTotals,
  effectiveCounts,
  folderFigures,
  rowsByShelf,
  sectionsOf,
  shelfStat,
  subtotalsOf,
} from "@/features/wishlist/wishShelfPlan";
import { buildFolderTree, trailOf } from "@/lib/folderTree";
import { layoutShelves } from "@/lib/shelfLayout";
import { visibleShelves, type Shelf } from "@/lib/shelves";
import { CabinetFilters } from "../CabinetFilters";
import type { WallItem } from "../CardWall";
import { wishItem } from "../items";
import { linkTo } from "../router";
import { DeckLink, EmptyShelfBox, PathRow, PhoneShelfHeading } from "../ShelfParts";
import { NO_ITEMS, ShelfWall } from "../ShelfWall";
import { DimNote, NextPageRefused, ReadError, useMore } from "./parts";

/** What the top of the cabinet is called — the desktop breadcrumb's word. */
const ROOT = "Wishlist";

/** A shut heading with nothing to peek at — one identity across renders. */
const NO_PEEK: readonly { cardId: string }[] = [];

/**
 * The wishlist's cabinet, read-only — the collection's page one table over, for the same reasons:
 * the desktop's own hook (`useWishlist`), the desktop's own shelves, the phone's own chrome, and a
 * fold pressed here held in the page rather than stored.
 *
 * **A deck's managed wishlist is a read.** Under **Managed by decks**, a `Theory + Actual` deck's
 * folder holds what the deck's Compare lists and is rewritten by the deck, never by hand — so its
 * heading carries the way to its deck, an empty one says which of the deck's views it follows, and
 * standing inside one says whose list it is with a **link** to the deck. Nothing on it is editable
 * here, which on a read-only page costs nothing to keep true.
 *
 * **One tile per wish**, keyed by the wish: two wishes for one card in two folders are two tiles,
 * and the chin's mark says the card is wished for again elsewhere.
 *
 * **Filtered as the collection is** (`CabinetFilters`), through the sheet with the desktop bar's
 * own cells for this list (`WISHLIST_TRAY`): no price, finish or condition, because a wish
 * carries none of the three questions those cells ask.
 */
export function WishlistPage({ onOpen }: { onOpen: (item: WallItem) => void }) {
  const stored = useShelfFolds("wishlist").folds;
  const [pressed, setPressed] = useState<Readonly<Record<string, boolean>>>({});
  const folds = useMemo(() => ({ ...stored, ...pressed }), [stored, pressed]);

  const wishlist = useWishlist({ folds });
  const { query, countsQuery, marketplace, shelves, filtering, folderId, openFolder } = wishlist;
  const currency = marketplace.currency;

  const folders = useWishlistFolders();
  const { decks } = useDecks();
  const trail = useMemo(() => trailOf(folders.folders, folderId), [folders.folders, folderId]);
  const subtotals = useMemo(
    () => subtotalsOf(buildFolderTree(folders.folders, []), folders.summary),
    [folders.folders, folders.summary],
  );
  const folderById = useMemo(
    () => new Map(folders.folders.map((folder) => [folder.id, folder])),
    [folders.folders],
  );

  const byShelf = useMemo(() => rowsByShelf(wishlist.rows), [wishlist.rows]);
  /** The counts the wall is laid out from — the server's, raised wherever more wishes are already
   *  loaded than they say. `null` until they have answered. */
  const counts = useMemo(
    () => effectiveCounts(wishlist.counts, byShelf),
    [wishlist.counts, byShelf],
  );
  const visible = useMemo(
    () => visibleShelves(shelves, counts, filtering),
    [shelves, counts, filtering],
  );
  const sections = useMemo(
    () => (counts === null ? null : sectionsOf(visible, counts)),
    [visible, counts],
  );

  const itemsByShelf = useMemo(() => {
    const out = new Map<number, WallItem[]>();
    for (const [shelf, rows] of byShelf) {
      out.set(
        shelf,
        rows.map((row) => wishItem(row, currency)),
      );
    }
    return out;
  }, [byShelf, currency]);
  const itemsOf = useCallback(
    (shelfId: number) => itemsByShelf.get(shelfId) ?? NO_ITEMS,
    [itemsByShelf],
  );

  // `hasMore`, not `query.hasNextPage`: the hook's own answer about the pages on screen — and none
  // while the previous level is still drawn, whose rows the next page would not follow.
  const more = useMore(query, wishlist.hasMore && !wishlist.levelHeld);

  const toggle = useCallback(
    (shelf: Shelf) => setPressed((now) => ({ ...now, [String(shelf.id)]: !shelf.collapsed })),
    [],
  );

  /** The deck a managed folder belongs to, by its own row — a deck's `Tokens` child carries the
   *  deck's id too. */
  const deckOf = useCallback(
    (folderId: number) => {
      const folder = folderById.get(folderId);
      if (folder === undefined || folder.managedDeckId === null) return null;
      return { folder, deck: decks.find((d) => d.id === folder.managedDeckId) };
    },
    [folderById, decks],
  );

  const renderHeading = useCallback(
    (shelf: Shelf) => {
      const managed = shelf.kind === "managed" ? deckOf(shelf.id) : null;
      return (
        <PhoneShelfHeading
          shelf={shelf}
          stat={
            counts === null
              ? "—"
              : shelfStat({
                  shelf,
                  shelves,
                  counts,
                  subtotal: folderFigures(shelf, folders.summaryQuery.isPending ? null : subtotals),
                  filtering,
                  currency,
                })
          }
          peek={counts?.get(shelf.id)?.peek.map((cardId) => ({ cardId })) ?? NO_PEEK}
          onToggle={() => toggle(shelf)}
          foldPaused={filtering ? FOLD_PAUSED_REASON : undefined}
          onOpenFolder={shelf.kind === "unfiled" ? undefined : () => openFolder(shelf.id)}
          aside={
            // The deck's own folder links to the deck; its `Tokens` child is named for no deck
            // and sits under the folder that does.
            managed !== null &&
            managed.folder.managedDeckId !== null &&
            !managed.folder.managedTokens ? (
              <DeckLink deckId={managed.folder.managedDeckId} name={shelf.name} />
            ) : undefined
          }
        />
      );
    },
    [
      deckOf,
      counts,
      shelves,
      folders.summaryQuery.isPending,
      subtotals,
      filtering,
      currency,
      toggle,
      openFolder,
    ],
  );
  const renderEmpty = useCallback(
    (shelf: Shelf) => {
      if (shelf.kind === "managed") {
        const managed = deckOf(shelf.id);
        // The sentence about the deck's view — which it follows, so why it is empty.
        return (
          <EmptyShelfBox>
            {managedEmptySentence(
              managed?.deck?.managedWishlist,
              managed?.folder.managedTokens === true,
            )}
          </EmptyShelfBox>
        );
      }
      return (
        <EmptyShelfBox>{shelf.headless ? "Nothing in this folder yet." : "Empty."}</EmptyShelfBox>
      );
    },
    [deckOf],
  );

  // Standing inside a deck's managed folder: whose list this is, and the way to the deck. Inside
  // its `Tokens` child the deck's name is the parent's, which Rust names after the deck.
  const here = folderId === null ? undefined : folderById.get(folderId);
  const managedHere = here !== undefined && here.managedDeckId !== null ? here : null;
  const managedDeckName =
    managedHere === null
      ? null
      : managedHere.managedTokens && managedHere.parentId !== null
        ? (folderById.get(managedHere.parentId)?.name ?? managedHere.name)
        : managedHere.name;

  // It scrolls with the wall, above the figures: the line and the path row are what stay put.
  const note =
    managedHere === null || managedHere.managedDeckId === null ? null : (
      <div className="pt-3">
        <ManagedFolderNote
          deckName={managedDeckName ?? managedHere.name}
          deckLink={linkTo({ view: "decks", deckId: managedHere.managedDeckId, cardId: null })}
        />
      </div>
    );
  const totals = countTotals(wishlist.counts);
  // The line and, standing in a folder, the way out of it — one band that stays put while the
  // wall scrolls. Drawn over every answer below, so a filter that matched nothing can be undone.
  const line = (
    <CabinetFilters
      surface={wishlist}
      label="Search your wishlist"
      tray={WISHLIST_TRAY}
      sortRows={wishlist.sortRows}
      total={totals?.wishes}
      below={
        folderId === null ? undefined : <PathRow root={ROOT} trail={trail} onOpen={openFolder} />
      }
    />
  );
  const top = (
    <>
      {line}
      {note !== null && <div className="shrink-0 px-3">{note}</div>}
    </>
  );

  if (query.isLoadingError) {
    return (
      <>
        {top}
        <ReadError>Your wishlist could not be read.</ReadError>
      </>
    );
  }
  if (countsQuery.isError && wishlist.counts === undefined) {
    return (
      <>
        {top}
        <ReadError>Your wishlist's shelves could not be read.</ReadError>
      </>
    );
  }

  // Nothing to draw — said only once the counts have answered.
  if (sections !== null && layoutShelves(sections, 1).rows.length === 0) {
    return (
      <>
        {top}
        <DimNote>
          {filtering
            ? "No cards match."
            : folderId === null
              ? "Nothing on your wishlist yet."
              : shelves.length === 0
                ? "That folder is gone."
                : "Nothing in this folder yet."}
        </DimNote>
      </>
    );
  }

  return (
    <>
      {line}
      <ShelfWall
        label="Your wishlist"
        sections={sections ?? []}
        itemsOf={itemsOf}
        header={
          <>
            {note}
            <div className="pt-3 pb-1">
              <WishlistSummaryHeader totals={totals} marketplace={marketplace} />
            </div>
          </>
        }
        renderHeading={renderHeading}
        renderEmpty={renderEmpty}
        onOpen={onOpen}
        onNearEnd={more}
        resetKey={wishlist.queryKeyString}
        footer={<NextPageRefused query={query} />}
      />
    </>
  );
}
