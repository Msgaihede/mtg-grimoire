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
 * Settings on the `sync` group that holds Needs review (`pendingSettingsGroup`), and Recently
 * removed is the folder hand-off `FoldersWidget` already makes. The scanner needs none.
 *
 * ## Rows or copies, and the caption says which
 *
 * The flagged rows count **rows** — `collection_summary.needsReview` counts entries, a flagged wish
 * is a wish, a flagged deck card a `deck_cards` row — and each row's name says the unit. The
 * removed folder counts **copies**, because that is how a reader thinks of a holding area, so its
 * caption says `5 copies` and it carries no second figure to say the same thing twice.
 * {@link reviewRows} is where every one of these words is decided, and it is pure.
 *
 * ## Five reads, one of them new
 *
 * The tray under its own count key — **never `["scanner","tray"]`**, which *is* the tray in the
 * window that owns the scanner (`useTray.ts`, written with `setQueryData`), and which this card
 * must not write into. The collection's flagged entries through `collectionTotalKey`, which is
 * `SummaryWidget`'s own read and one fetch between the two. The flagged wishes as the `total` of a
 * one-row page, flattened so a wish filed in a drawer counts. `deck_review_count`, the one new
 * command — `sync_relay_status.reviewCount` sums six tables, is desktop-only and takes the write
 * lock. And `Recently removed` through `useCollectionFolders`: **found in the list, then looked up
 * in the summary**, because an empty folder answers no summary row and a missing row is zero.
 *
 * ## The browser build
 *
 * There is no scanner there (`ScannerPage.tsx:100`), so the tray is neither read nor drawn; and
 * `sync_review_list` is not routed on the web target, so the deck cards row is drawn **without a
 * press** and its hint says where the flags can be cleared. `web` is a prop defaulting to
 * `isWebTarget()` because that answer is a build-time define the workbench folds to the desktop
 * one — a story names it; the page never does.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import type { ReactElement, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, Heart, Inbox } from "lucide-react";

import { CabinetFiling, Cards } from "@/components/icons";
import { useCollectionFolders } from "@/features/collection/useCollectionFolders";
import { unresolvedCount } from "@/features/scanner/reader/tray";
import { count } from "@/lib/counts";
import { ipc, ipcError, type ScannerTrayRow, type WishlistQuery } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { isWebTarget } from "@/pwa/target";

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
  /** `false` only for the deck cards on the browser build, which have nowhere to open. */
  pressable: boolean;
  hint?: string;
  /** The removed folder's id, for the folder hand-off. */
  folderId?: number;
}

/** A row with a caption is 51px, a bare one 36 — `SetCompletionWidget.tsx:55-57`'s sum. */
const ROW_CAPTIONED = 51;
const ROW_BARE = 36;

const PENDING = "Looking for anything waiting on you…";
export const EMPTY = "Nothing waiting for you.";
export const WEB_DECK_HINT =
  "The browser build has no Needs review list to open — clear these in the desktop app, under Settings → Sync.";
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

/** The tray's two numbers. A row is still a choice while it has `choices` — the tray's own
 *  {@link unresolvedCount}, asked rather than restated, so the rule has one spelling. */
export function trayCounts(rows: readonly ScannerTrayRow[]): { scanned: number; unresolved: number } {
  return { scanned: rows.length, unresolved: unresolvedCount(rows) };
}

function flaggedRow(
  kind: "binder" | "wishes" | "deckCards",
  name: string,
  n: number,
  pressable: boolean,
  hint?: string,
): ReviewRow {
  return {
    kind,
    name,
    caption: FLAGGED,
    tileCaption: `${count(n)} flagged`,
    value: count(n),
    pressable,
    hint,
  };
}

/**
 * Which rows are drawn, in which order, with which words — the whole of this card's judgement.
 *
 * A row is drawn only when its count is above zero. The browser build draws no scanner row and a
 * deck cards row with no press; the reader's `Recently removed` switch takes that row away, and a
 * database with no holding area never draws it.
 */
export function reviewRows(
  counts: ReviewCounts,
  opts: { web: boolean; removed: boolean },
): ReviewRow[] {
  const rows: ReviewRow[] = [];
  if (!opts.web && counts.scanned > 0) {
    const n = counts.unresolved;
    rows.push({
      kind: "scanned",
      name: "Scanned cards",
      caption: n > 0 ? `${count(n)} ${n === 1 ? "needs" : "need"} a printing chosen` : "Ready to add",
      tileCaption:
        n > 0 ? `${count(counts.scanned)} · ${count(n)} to choose` : `${count(counts.scanned)} ready`,
      value: count(counts.scanned),
      pressable: true,
    });
  }
  if (counts.binder > 0) rows.push(flaggedRow("binder", "Binder entries", counts.binder, true));
  if (counts.wishes > 0) rows.push(flaggedRow("wishes", "Wishes", counts.wishes, true));
  if (counts.deckCards > 0) {
    rows.push(
      flaggedRow(
        "deckCards",
        "Deck cards",
        counts.deckCards,
        !opts.web,
        opts.web ? WEB_DECK_HINT : undefined,
      ),
    );
  }
  if (opts.removed && counts.removed > 0 && counts.removedFolderId !== null) {
    const copies = `${count(counts.removed)} ${counts.removed === 1 ? "copy" : "copies"}`;
    rows.push({
      kind: "removed",
      name: "Recently removed",
      caption: copies,
      tileCaption: copies,
      value: null,
      pressable: true,
      folderId: counts.removedFolderId,
    });
  }
  return rows;
}

/** The whole row in one string — a `gap` between flex children with no whitespace text node
 *  computes to "WishesFlagged for review1" (`DecksWidget.tsx:314-321`). */
function spoken(row: ReviewRow): string {
  return [row.name, row.caption, row.value]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
}

export function ToReviewWidget({
  widget,
  fit,
  still,
  web = isWebTarget(),
}: WidgetBodyProps & { web?: boolean }): ReactElement {
  const withRemoved = toggleOnOf(widget, "removed");
  const { marketplace } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingReviewFilter = useAppStore((s) => s.setPendingReviewFilter);
  const setPendingSettingsGroup = useAppStore((s) => s.setPendingSettingsGroup);
  const setPendingFolder = useAppStore((s) => s.setPendingFolder);

  const tray = useQuery({
    queryKey: scannerTrayCountKey,
    queryFn: async () => trayCounts(await ipc.scannerTray()),
    // No scanner on the browser build, and `scanner_tray` is not routed there.
    enabled: !web,
    // Nothing invalidates this key — the tray's writes feed `["scanner", "tray"]` by
    // `setQueryData` — so it is read afresh on every mount rather than trusted for the app's 30 s.
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
        Could not read what is waiting — {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (
    collection.data === undefined ||
    wishes.data === undefined ||
    deckCards.data === undefined ||
    (!web && tray.data === undefined) ||
    (withRemoved && (folders.query.data === undefined || folders.summaryQuery.data === undefined))
  ) {
    return <WidgetMessage>{PENDING}</WidgetMessage>;
  }

  // Found in the list, then looked up: an empty folder answers no summary row.
  const removedFolder = folders.folders.find((entry) => entry.kind === "removed") ?? null;
  const rows = reviewRows(
    {
      scanned: tray.data?.scanned ?? 0,
      unresolved: tray.data?.unresolved ?? 0,
      binder: collection.data.needsReview,
      wishes: wishes.data,
      deckCards: deckCards.data,
      removed: removedFolder === null ? 0 : (folders.summary.get(removedFolder.id)?.cards ?? 0),
      removedFolderId: removedFolder?.id ?? null,
    },
    { web, removed: withRemoved },
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
        setPendingSettingsGroup("sync");
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
        const onPress = still || !row.pressable ? undefined : () => open(row);
        const pressLabel = onPress === undefined ? undefined : spoken(row);
        return tile ? (
          <WidgetRow
            key={row.kind}
            name={row.name}
            caption={row.tileCaption}
            captionStrong
            icon={ICONS[row.kind]}
            hint={row.hint}
            onPress={onPress}
            pressLabel={pressLabel}
          />
        ) : (
          <WidgetRow
            key={row.kind}
            name={row.name}
            caption={captioned ? row.caption : undefined}
            value={row.value ?? (captioned ? undefined : row.caption)}
            icon={ICONS[row.kind]}
            hint={row.hint}
            onPress={onPress}
            pressLabel={pressLabel}
          />
        );
      })}
    </WidgetRowList>
  );
}
