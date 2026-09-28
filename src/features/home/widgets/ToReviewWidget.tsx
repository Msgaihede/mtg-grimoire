/**
 * What is waiting on the reader, one row per place it is waiting in — the scanner's tray, flagged
 * binder entries, flagged wishes, flagged deck cards, and the copies held in `Recently removed`.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the settings popover (one registry switch,
 * `Recently removed`) and the Customize tray; this draws the rows, cut to the box `fit` describes.
 *
 * ## One row per place, and each row opens that place
 *
 * Chosen by the reader over a single row into Settings (spec §1). A press is a view change and,
 * where the page does not open in the right state by itself, **a one-shot hand-off written after
 * it** — `setActiveView` first and the hand-off second, because the view change is what clears
 * every hand-off (`store.ts`'s `pendingFolder` argues it once for all of them). The binder and the
 * wishlist open with their needs-review filter on (`pendingReviewFilter`), the deck cards open
 * Settings with the Needs review panel brought into view (`pendingSettingsPanel`, `"review"` — the
 * page opens the `sync` group that holds it and scrolls it to the top, because the group alone left
 * the flagged rows below the fold), and Recently removed is the folder hand-off `FoldersWidget`
 * already makes. The scanner needs none.
 *
 * ## Rows or copies, and the caption says which
 *
 * The flagged rows count **rows** — `collection_summary.needsReview` counts entries, a flagged wish
 * is a wish, a flagged deck card a `deck_cards` row — and each row's name says the unit. The
 * removed folder counts **copies**, because that is how a reader thinks of a holding area, so its
 * caption says `5 copies` and it carries no second figure to say the same thing twice. **The
 * scanned cards count copies too, in the Scanner's own words** — its figure is the copies the
 * tray's heading counts and its caption the tray's `N cards to pick` — because the row opens that
 * tray, and the two must read one number the same way ({@link trayCounts}). {@link reviewRows} is
 * where every one of these words is decided, and it is pure.
 *
 * **A press is named by what its row draws**, and only that ({@link spoken}): the name, then the
 * caption and the figure this box drew — WCAG 2.5.3's label in name.
 *
 * ## Five reads, one of them new
 *
 * The tray under its own count key — **never `["scanner","tray"]`**, which *is* the tray in the
 * window that owns the scanner (`useTray.ts`, written with `setQueryData`), and which this card
 * must not write into. The collection's flagged entries through `collectionTotalKey`, which is
 * `SummaryWidget`'s own read and one fetch between the two. The flagged wishes as the `total` of a
 * one-row page, flattened so a wish filed in a drawer counts. `deck_review_count`, the one new
 * command — `sync_relay_status.reviewCount` sums six tables and takes the write lock. And
 * `Recently removed` through `useCollectionFolders`: **found in the list, then looked up in the
 * summary**, because an empty folder answers no summary row and a missing row is zero.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import type { ReactElement, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, Heart, Inbox } from "lucide-react";

import { CabinetFiling, Cards } from "@/components/icons";
import { useCollectionFolders } from "@/features/collection/useCollectionFolders";
import { totalCopies, unresolvedCount } from "@/features/scanner/reader/tray";
import { count } from "@/lib/counts";
import { ipc, ipcError, type ScannerTrayRow, type WishlistQuery } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";

import {
  collectionTotalKey,
  deckReviewCountKey,
  scannerTrayCountKey,
  wishlistReviewCountKey,
} from "../keys";
import { WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { toggleOnOf } from "../widgetSettings";

/** The five places, in the order they are always drawn. */
export type ReviewRowKind = "scanned" | "binder" | "wishes" | "deckCards" | "removed";

/** What the five reads answered, as plain numbers. `removedFolderId` is `null` in a database with
 *  no holding area — every real one has one, and a row that could open nothing is not drawn. */
export interface ReviewCounts {
  scanned: number;
  unresolved: number;
  binder: number;
  wishes: number;
  deckCards: number;
  removed: number;
  removedFolderId: number | null;
}

/** One row as the body draws it. Every word is decided in {@link reviewRows}. */
export interface ReviewRow {
  kind: ReviewRowKind;
  name: string;
  /** The line under the name on a panel. */
  caption: string;
  /** The line under the name on a two-cell tile, where it carries the count. */
  tileCaption: string;
  /** The figure at the right, or `null` where the caption already is the count. */
  value: string | null;
  /** The removed folder's id, for the folder hand-off. */
  folderId?: number;
}

/** A row with a caption is 51px, a bare one 36 — `SetCompletionWidget.tsx:55-57`'s sum. */
const ROW_CAPTIONED = 51;
const ROW_BARE = 36;

const PENDING = "Loading review items…";
export const EMPTY = "Nothing to review.";
const FLAGGED = "Flagged for review";

/** The flagged wishes, as a one-row page: `total` is the count, and `flatten` reaches every
 *  drawer. `limit: 1` rather than `0`, which the backend reads as its default page of 100. */
const FLAGGED_WISHES: WishlistQuery = { needsReview: true, flatten: true, limit: 1, offset: 0 };

/**
 * Each place's glyph — **the navigation rail's own** where the row opens a view (`nav.ts`: `Camera`
 * for the scanner, not `ScanLine`, which drew a barcode reader; `CabinetFiling`, `Heart`, `Cards`),
 * and `Inbox` for the holding area, which is the glyph `PinnedFolders.tsx` gives it.
 */
const ICONS: Record<ReviewRowKind, ReactNode> = {
  scanned: <Camera className="size-3.5" aria-hidden="true" />,
  binder: <CabinetFiling className="size-3.5" aria-hidden="true" />,
  wishes: <Heart className="size-3.5" aria-hidden="true" />,
  deckCards: <Cards className="size-3.5" aria-hidden="true" />,
  removed: <Inbox className="size-3.5" aria-hidden="true" />,
};

/**
 * The tray's two numbers, **as the Scanner counts them**: `scanned` is copies — the tray's own
 * {@link totalCopies}, which heads its tray `Scanned cards 2` over one row of two — and
 * `unresolved` is rows still waiting on a printing, {@link unresolvedCount}, which the tray says as
 * `1 card to pick`. Both asked rather than restated, so each rule has one spelling; the live pass
 * (2026-09-26) found this row counting rows and reading `1` beside a Scanner reading `2`.
 */
export function trayCounts(rows: readonly ScannerTrayRow[]): { scanned: number; unresolved: number } {
  return { scanned: totalCopies(rows), unresolved: unresolvedCount(rows) };
}

/** `1 copy`, `6 copies` — with the thousands separator every other count here carries. */
function copies(n: number): string {
  return `${count(n)} ${n === 1 ? "copy" : "copies"}`;
}

function flaggedRow(kind: "binder" | "wishes" | "deckCards", name: string, n: number): ReviewRow {
  return {
    kind,
    name,
    caption: FLAGGED,
    tileCaption: `${count(n)} flagged`,
    value: count(n),
  };
}

/**
 * Which rows are drawn, in which order, with which words — the whole of this card's judgement.
 *
 * A row is drawn only when its count is above zero. The reader's `Recently removed` switch takes
 * that row away, and a database with no holding area never draws it.
 */
export function reviewRows(counts: ReviewCounts, opts: { removed: boolean }): ReviewRow[] {
  const rows: ReviewRow[] = [];
  if (counts.scanned > 0) {
    // `TrayPanel`'s words for its two numbers: the figure is the copies its heading counts, and
    // the caption the `N cards to pick` beside it. The tile has no heading to lean on, so it names
    // the copies.
    const n = counts.unresolved;
    rows.push({
      kind: "scanned",
      name: "Scanned cards",
      caption: n > 0 ? `${count(n)} ${n === 1 ? "card" : "cards"} to pick` : "Ready to add",
      tileCaption:
        n > 0 ? `${copies(counts.scanned)} · ${count(n)} to pick` : `${copies(counts.scanned)} ready`,
      value: count(counts.scanned),
    });
  }
  if (counts.binder > 0) rows.push(flaggedRow("binder", "Collection entries", counts.binder));
  if (counts.wishes > 0) rows.push(flaggedRow("wishes", "Wishlist items", counts.wishes));
  if (counts.deckCards > 0) rows.push(flaggedRow("deckCards", "Deck cards", counts.deckCards));
  if (opts.removed && counts.removed > 0 && counts.removedFolderId !== null) {
    const held = copies(counts.removed);
    rows.push({
      kind: "removed",
      name: "Recently removed",
      caption: held,
      tileCaption: held,
      value: null,
      folderId: counts.removedFolderId,
    });
  }
  return rows;
}

/**
 * A press's name: **the parts the row draws**, joined — never the parts it could have drawn.
 *
 * One string, because a `gap` between flex children with no whitespace text node computes to
 * "WishesFlagged for review1" (`DecksWidget.tsx:314-321`). And only what is drawn, because a name
 * that does not contain the visible text fails WCAG 2.5.3: the tile drew `3 flagged` and spoke
 * `Wishes · Flagged for review · 3` (the final review, 2026-09-26), so a reader driving by voice
 * could not say what they saw. The body hands over exactly the caption and figure it passes to the
 * row, so the two cannot come apart.
 */
function spoken(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

export function ToReviewWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const withRemoved = toggleOnOf(widget, "removed");
  const { marketplace } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingReviewFilter = useAppStore((s) => s.setPendingReviewFilter);
  const setPendingSettingsPanel = useAppStore((s) => s.setPendingSettingsPanel);
  const setPendingFolder = useAppStore((s) => s.setPendingFolder);

  const tray = useQuery({
    queryKey: scannerTrayCountKey,
    queryFn: async () => trayCounts(await ipc.scannerTray()),
    // With one window open nothing invalidates this key — the tray's writes feed
    // `["scanner", "tray"]` by `setQueryData`, and the Scanner and this card are never on screen
    // together — so it is read afresh on every mount rather than trusted for the app's 30 s. A
    // second window's tray write is an `app_meta` commit, which `lib/crossWindow.ts` answers by
    // refreshing this key here (`FOLLOW_LIVE_APP_META`).
    staleTime: 0,
  });
  const collection = useQuery({
    queryKey: collectionTotalKey(marketplace.id),
    // `SummaryWidget.tsx:174-181`'s query verbatim, so the two share one cache entry: no filter at
    // all is the whole cabinet, and `limit: 0` is the summary's idiom for "count, do not list".
    queryFn: () => ipc.collectionSummary({ limit: 0, offset: 0, marketplace: marketplace.id }),
  });
  const wishes = useQuery({
    queryKey: wishlistReviewCountKey,
    queryFn: async () => (await ipc.wishlistList(FLAGGED_WISHES)).total,
  });
  const deckCards = useQuery({
    queryKey: deckReviewCountKey,
    queryFn: () => ipc.deckReviewCount(),
  });
  const folders = useCollectionFolders();

  // One sentence for any refusal, `SummaryWidget`'s rule: a reader whose database will not answer
  // one of these is not helped by learning which, and the backend's words are the part to read.
  const failure =
    collection.error ??
    wishes.error ??
    deckCards.error ??
    tray.error ??
    (withRemoved ? (folders.query.error ?? folders.summaryQuery.error) : null);
  if (failure !== null) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load review items — {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (
    collection.data === undefined ||
    wishes.data === undefined ||
    deckCards.data === undefined ||
    tray.data === undefined ||
    (withRemoved && (folders.query.data === undefined || folders.summaryQuery.data === undefined))
  ) {
    return <WidgetMessage>{PENDING}</WidgetMessage>;
  }

  // Found in the list, then looked up: an empty folder answers no summary row.
  const removedFolder = folders.folders.find((entry) => entry.kind === "removed") ?? null;
  const rows = reviewRows(
    {
      scanned: tray.data.scanned,
      unresolved: tray.data.unresolved,
      binder: collection.data.needsReview,
      wishes: wishes.data,
      deckCards: deckCards.data,
      removed: removedFolder === null ? 0 : (folders.summary.get(removedFolder.id)?.cards ?? 0),
      removedFolderId: removedFolder?.id ?? null,
    },
    { removed: withRemoved },
  );
  if (rows.length === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;

  /** Each place, and the hand-off it needs — **the view first**, because the view change clears
   *  every hand-off and the inverse leaves the store holding nothing. */
  const open = (row: ReviewRow) => {
    switch (row.kind) {
      case "scanned":
        setActiveView("scanner");
        return;
      case "binder":
        setActiveView("collection");
        setPendingReviewFilter({ scope: "collection" });
        return;
      case "wishes":
        setActiveView("wishlist");
        setPendingReviewFilter({ scope: "wishlist" });
        return;
      case "deckCards":
        setActiveView("settings");
        setPendingSettingsPanel("review");
        return;
      case "removed":
        if (row.folderId === undefined) return;
        setActiveView("collection");
        setPendingFolder({ scope: "collection", id: row.folderId });
        return;
    }
  };

  /**
   * What the box carries. **On a two-cell tile the count moves under the name** — `WidgetRow`'s rule
   * — as a short phrase that says its unit. A compact panel drops the caption and keeps the figure;
   * the removed row, whose caption *is* its figure, keeps that as the figure instead.
   */
  const tile = fit.tier === 0;
  const captioned = tile || !fit.compact;
  const shown = rows.slice(0, fit.rowsFit(captioned ? ROW_CAPTIONED : ROW_BARE));

  return (
    <WidgetRowList fit={fit}>
      {shown.map((row) => {
        const onPress = still ? undefined : () => open(row);
        // What this box draws under the name and at the right — and so what the press is named.
        const caption = tile ? row.tileCaption : captioned ? row.caption : undefined;
        const value = tile ? undefined : (row.value ?? (captioned ? undefined : row.caption));
        const pressLabel = onPress === undefined ? undefined : spoken(row.name, caption, value);
        return tile ? (
          <WidgetRow
            key={row.kind}
            name={row.name}
            caption={caption}
            captionStrong
            icon={ICONS[row.kind]}
            onPress={onPress}
            pressLabel={pressLabel}
          />
        ) : (
          <WidgetRow
            key={row.kind}
            name={row.name}
            caption={caption}
            value={value}
            icon={ICONS[row.kind]}
            onPress={onPress}
            pressLabel={pressLabel}
          />
        );
      })}
    </WidgetRowList>
  );
}
