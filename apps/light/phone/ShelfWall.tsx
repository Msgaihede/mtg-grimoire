import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ShelfLabel } from "@grimoire/ui/features/shelves/ShelfLabel";
import { PendingSlot, shelfRowKey } from "@grimoire/ui/features/shelves/shelfRows";
import {
  fillShelves,
  loadedShelves,
  rowOfTile,
  type LayoutRow,
  type ShelfSection,
} from "@grimoire/ui/lib/shelfLayout";
import type { Shelf } from "@grimoire/ui/lib/shelves";
import { useElementWidth } from "@grimoire/ui/lib/useElementWidth";
import type { WallItem } from "./CardWall";
import {
  columnsFor,
  GAP,
  rowHeightFor,
  SHELF_INDENT_PX,
  shelfRowHeight,
  tileWidthFor,
} from "./wall";
import { WallTile } from "./WallTile";

/** One answer for "this shelf has nothing loaded", so an empty shelf is one object every render. */
export const NO_ITEMS: readonly WallItem[] = [];

/** How tall one box is, kept current by a `ResizeObserver` — `0` until it has reported, which is
 *  for ever under jsdom. `useElementWidth`'s shape, for its reasons, one axis over. */
function useElementHeight<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [height, setHeight] = useState(0);
  const ref = useCallback((el: T | null) => {
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

/** A run of consecutive drawn rows that belong together: one shelf's rows of tiles, or one other
 *  row on its own. */
type Run =
  | { kind: "tiles"; shelf: Shelf; rows: { index: number; start: number; key: string }[] }
  | { kind: "row"; index: number; start: number; key: string };

/**
 * The phone's sectioned wall: the shelves of a cabinet, each a heading over its own cards.
 *
 * **Laid out from the counts, not from what has loaded** — `lib/shelfLayout.ts`, the desktop
 * wall's own arithmetic: every shelf is as tall as its count says, so every heading is placed
 * before a single card has arrived, a page landing fills frames that were already there, and
 * nothing reflows under the reader's thumb. A frame whose page is still on its way is the
 * desktop's `PendingSlot`. Only the heights are the phone's (`wall.ts`).
 *
 * **Each shelf is its own list, named for the shelf**, and each card in it says where it stands
 * (`aria-setsize`, `aria-posinset`) — so a screen reader hears *12 items* for a shelf of twelve
 * cards, never the number of rows the wall happens to wrap them into, and hears the right total
 * while most of a long shelf is virtualised away.
 *
 * It scrolls inside itself, `CardWall`'s rule; `header` scrolls with it, above the first shelf,
 * so a figures band and a path row cost the cards no height once the reader is in among them.
 *
 * **What a heading and an empty shelf draw is the page's** (`renderHeading`, `renderEmpty`) —
 * a collection's heading and a wishlist's say different things about different rows. What a
 * label draws is the desktop's `ShelfLabel`.
 */
export function ShelfWall({
  label,
  sections,
  itemsOf,
  header,
  renderHeading,
  renderEmpty,
  shelfLabel,
  onOpen,
  actionsFor,
  onNearEnd,
  resetKey,
  footer,
}: {
  /** What the wall is, for a screen reader: "Your collection", "Your wishlist". */
  label: string;
  /** The shelves to draw, in wall order, each sized by its count — `0` for a shut one. Held still
   *  by the caller: a new array is a new layout. */
  sections: readonly ShelfSection[];
  /** The loaded cards on one shelf, in order. Held still by the caller, as `sections` is. */
  itemsOf: (shelfId: number) => readonly WallItem[];
  /** Drawn above the shelves, and scrolled with them. */
  header?: ReactNode;
  renderHeading: (shelf: Shelf) => ReactNode;
  renderEmpty: (shelf: Shelf) => ReactNode;
  /** What a shelf's list is called. Defaults to the shelf's own name. */
  shelfLabel?: (shelf: Shelf) => string;
  onOpen: (item: WallItem) => void;
  /**
   * The press behind a tile's `⋯` (`WallTile.onActions`), or `undefined` for a tile that offers
   * none — a deck's managed wish, which nothing on the phone may edit. Absent, no tile has one.
   */
  actionsFor?: (item: WallItem) => (() => void) | undefined;
  /** `CardWall.onNearEnd`'s contract: asked often near the end, so it must be idempotent. */
  onNearEnd?: () => void;
  /** Changes when this is a different list — a level, a filter, a sort — and sends the wall to
   *  its top. */
  resetKey: string;
  /**
   * Drawn after the last shelf, inside the scroller — `CardWall.footer`'s contract, and for its
   * reason: the rows are absolutely placed, so anything in their box's own flow would be drawn
   * under the first one. A page's `NextPageRefused` is what goes here.
   */
  footer?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const [measureHeader, headerHeight] = useElementHeight<HTMLDivElement>();
  const columns = columnsFor(width);
  const tileWidth = tileWidthFor(width, columns);
  const tileRowHeight = rowHeightFor(tileWidth);

  const loaded = useMemo(() => loadedShelves(sections, itemsOf), [sections, itemsOf]);
  /** How many cards each shelf holds, as laid out — what each card's `aria-setsize` says. */
  const setSizes = useMemo(
    () => new Map(loaded.map(({ section }) => [section.shelf.id, section.tileCount])),
    [loaded],
  );
  const { layout, slots, frontier } = useMemo(
    () => fillShelves(loaded, columns),
    [loaded, columns],
  );

  const rows = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => shelfRowHeight(layout.rows[index]?.kind ?? "tiles", tileRowHeight),
    getItemKey: (index) => shelfRowKey(layout, index),
    // The header is in the scroller's content above the rows, so the rows start below it.
    scrollMargin: headerHeight,
    overscan: 3,
  });

  // Row heights follow the wall's width and the layout (a shelf opening adds rows above every row
  // below it). Before paint: after it, one frame draws rows at offsets measured for the old ones.
  useLayoutEffect(() => {
    rows.measure();
  }, [rows, tileRowHeight, layout]);

  // A different list starts at its top, before paint — `CardWall`'s rule.
  useLayoutEffect(() => {
    rows.scrollToOffset(0);
  }, [rows, resetKey]);

  const drawn = rows.getVirtualItems();
  const lastDrawn = drawn.length > 0 ? drawn[drawn.length - 1].index : -1;

  /**
   * **More is asked for once the row holding the first unloaded frame is drawn** — or, with
   * every counted frame loaded, the row of the last tile. The frames are placed from the counts
   * before their page exists, so a reader scrolling onto them is a reader about to need them, and
   * the virtualiser's overscan is the look-ahead. The desktop wall's rule, row for row.
   */
  const frontierRow =
    layout.totalTiles === 0 ? -1 : rowOfTile(layout, Math.min(frontier, layout.totalTiles - 1));
  const askForMore = useEffectEvent(() => onNearEnd?.());
  useEffect(() => {
    if (frontierRow >= 0 && lastDrawn >= frontierRow) askForMore();
  }, [lastDrawn, frontierRow]);

  // Consecutive tile rows of one shelf are drawn inside one list, so each shelf is a list.
  const runs: Run[] = [];
  for (const item of drawn) {
    const row = layout.rows[item.index];
    if (row === undefined) continue;
    const at = { index: item.index, start: item.start - headerHeight, key: String(item.key) };
    const last = runs[runs.length - 1];
    if (row.kind === "tiles") {
      if (last !== undefined && last.kind === "tiles" && last.shelf.id === row.shelf.id) {
        last.rows.push(at);
      } else {
        runs.push({ kind: "tiles", shelf: row.shelf, rows: [at] });
      }
    } else {
      runs.push({ kind: "row", ...at });
    }
  }

  const tileRow = (row: Extract<LayoutRow, { kind: "tiles" }>, start: number, key: string) => {
    const first = layout.tileStart.get(row.shelf.id) ?? row.start;
    const setSize = setSizes.get(row.shelf.id) ?? row.end - first;
    return (
      <div
        key={key}
        className="absolute inset-x-0 top-0 flex"
        style={{ transform: `translateY(${start}px)`, height: tileRowHeight, gap: GAP }}
      >
        {Array.from({ length: row.end - row.start }, (_, i) => {
          const slot = row.start + i;
          const item = slots[slot];
          return item ? (
            <div
              // Keyed by place in the row: a card that lands in a frame replaces it, and nothing
              // else in the row remounts.
              key={`slot-${i}`}
              role="listitem"
              aria-setsize={setSize}
              aria-posinset={slot - first + 1}
              className="flex min-w-0 flex-1"
            >
              <WallTile
                item={item}
                onOpen={onOpen}
                onActions={actionsFor?.(item)}
                className="min-w-0 flex-1"
              />
            </div>
          ) : (
            <div key={`slot-${i}`} aria-hidden className="min-w-0 flex-1">
              <PendingSlot slot={slot} width={tileWidth} />
            </div>
          );
        })}
        {/* A short last row keeps its tiles the width of the rows above it. */}
        {Array.from({ length: columns - (row.end - row.start) }, (_, i) => (
          <span key={`pad-${i}`} aria-hidden className="min-w-0 flex-1" />
        ))}
      </div>
    );
  };

  return (
    <div
      ref={scroller}
      role="region"
      aria-label={label}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3"
    >
      <div ref={measureHeader}>
        {/* The page's title is the `h1`; each shelf heading is an `h3` and deeper, as on the
            desktop, so the wall itself is the `h2` between them. */}
        <h2 className="sr-only">{label}</h2>
        {header}
      </div>
      <div ref={measure} className="relative w-full" style={{ height: rows.getTotalSize() }}>
        {runs.map((run) => {
          if (run.kind === "tiles") {
            return (
              <div
                key={`shelf:${run.shelf.id}`}
                role="list"
                aria-label={shelfLabel ? shelfLabel(run.shelf) : run.shelf.name}
              >
                {run.rows.map((at) => {
                  const row = layout.rows[at.index] as Extract<LayoutRow, { kind: "tiles" }>;
                  return tileRow(row, at.start, at.key);
                })}
              </div>
            );
          }
          const row = layout.rows[run.index];
          return (
            <div
              key={run.key}
              className="absolute inset-x-0 top-0"
              style={{
                transform: `translateY(${run.start}px)`,
                height: shelfRowHeight(row.kind, tileRowHeight),
                // A label stands at the wall's own edge; a heading and its empty box move in
                // together, so the box sits under the name it belongs to.
                paddingLeft: row.kind === "label" ? 0 : row.shelf.indent * SHELF_INDENT_PX,
              }}
            >
              {row.kind === "label" ? (
                <ShelfLabel group={row.group} />
              ) : row.kind === "heading" ? (
                renderHeading(row.shelf)
              ) : (
                renderEmpty(row.shelf)
              )}
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
