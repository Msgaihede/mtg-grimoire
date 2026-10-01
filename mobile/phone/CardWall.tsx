import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CardTile } from "@/components/CardTile";
import type { ChinPrinting } from "@/components/CardChin";
import { CountTag } from "@/components/CountTag";
import type { Finish } from "@/lib/finish";
import { useElementWidth } from "@/lib/useElementWidth";
import { columnsFor, GAP, rowHeightFor, tileWidthFor } from "./wall";

/** One tile's worth of facts — what every list on the phone face is turned into. */
export interface WallItem {
  /** Unique on the wall. A collection row's id, not its card's: one printing can be two rows. */
  key: string;
  /** The picture. `null` draws the named frame. */
  cardId: string | null;
  name: string;
  rarity: string | null;
  chin: ChinPrinting;
  finish: Finish | null;
  /** Already formatted. `undefined` draws no money slot at all. */
  money: string | undefined;
  /** Copies. Drawn as a tag on the art only above one, and said in the tile's name there too. */
  count: number;
  /**
   * The tile's accessible name — the card and its printing, so two printings are two names.
   *
   * **Leave the count out of it; the wall adds it.** The tag that draws {@link count} is
   * `aria-hidden` and sits inside the tile's button, whose `aria-label` replaces its contents —
   * so the name is the only place a count above one can reach a screen reader, and the wall
   * writes `…, 3 copies` onto the end of this.
   */
  pressLabel: string;
}

/** How close to the end of what is loaded the reader gets before more is asked for. */
const NEAR_END_ROWS = 4;

/**
 * A wall of card tiles, virtualised by row.
 *
 * It scrolls inside itself: the phone shell gives it the space between the top bar and the tab
 * bar, and nothing else on a page scrolls. Only the rows near the viewport are mounted, so a
 * search of five thousand cards costs what a screenful does.
 */
export function CardWall({
  label,
  items,
  onOpen,
  onNearEnd,
  resetKey,
}: {
  /** What this wall is a list of, for a screen reader: "Search results", "Your collection". */
  label: string;
  items: readonly WallItem[];
  onOpen: (item: WallItem) => void;
  /**
   * Asked when the reader nears the end of `items`. The page decides whether there is more.
   *
   * **It may be called more than once near the end, so it must be idempotent** — it is asked
   * again each time the last drawn row or the number of rows moves while the end is still near,
   * which is every scroll step down there and every page that arrives. A caller checks whether
   * there is a next page and whether one is already on its way. What it is *not* asked for is
   * being a new function: a page hands down a fresh closure whenever its query moves, and that
   * is not the reader moving.
   */
  onNearEnd?: () => void;
  /** Changes when this is a different list — a new search — and sends the wall back to its top. */
  resetKey: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // The list, not the scroller: the scroller's own padding is not room a tile can be drawn in,
  // and `useElementWidth` answers the content box of whatever it is put on.
  const [measure, width] = useElementWidth<HTMLUListElement>();
  const columns = columnsFor(width);
  const tileWidth = tileWidthFor(width, columns);
  const rowHeight = rowHeightFor(tileWidth);
  const rowCount = Math.ceil(items.length / columns);

  const rows = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  });

  // A row's height follows the wall's width; tell the virtualiser when it moves. **Before paint**:
  // after it, one frame draws rows of the new height at the offsets measured for the old one.
  useLayoutEffect(() => {
    rows.measure();
  }, [rows, rowHeight]);

  // A different list starts at its top — and before paint, or one frame shows the new list at the
  // old list's offset. Through the virtualiser rather than the element, so the window it draws
  // and the offset it believes in move together.
  useLayoutEffect(() => {
    rows.scrollToOffset(0);
  }, [rows, resetKey]);

  const drawn = rows.getVirtualItems();
  const lastDrawn = drawn.length > 0 ? drawn[drawn.length - 1].index : -1;

  // The newest callback, read when the effect below fires rather than listed as one of its
  // reasons to: see `onNearEnd`.
  const askForMore = useEffectEvent(() => onNearEnd?.());

  useEffect(() => {
    // `lastDrawn >= 0`: the first render draws no row at all — nothing has measured the scroller
    // — and for a list of three rows or fewer "no row yet" passes the comparison beside it.
    if (lastDrawn >= 0 && lastDrawn >= rowCount - NEAR_END_ROWS) askForMore();
  }, [lastDrawn, rowCount]);

  return (
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
      <ul
        ref={measure}
        aria-label={label}
        className="relative w-full"
        style={{ height: rows.getTotalSize() }}
      >
        {drawn.map((row) => (
          <li
            key={row.key}
            className="absolute left-0 top-0 flex w-full"
            style={{ transform: `translateY(${row.start}px)`, height: rowHeight, gap: GAP }}
          >
            {items.slice(row.index * columns, row.index * columns + columns).map((item) => {
              const copies = item.count > 1 ? `${item.count} copies` : null;
              return (
                <CardTile
                  key={item.key}
                  className="min-w-0 flex-1"
                  cardId={item.cardId}
                  name={item.name}
                  rarity={item.rarity}
                  chin={item.chin}
                  finish={item.finish}
                  money={item.money}
                  pressLabel={copies === null ? item.pressLabel : `${item.pressLabel}, ${copies}`}
                  onPress={() => onOpen(item)}
                  overlay={
                    copies === null ? undefined : (
                      // The tag as it is, placed by its own `className`: it is a filled, slanted
                      // banner already, and a backed chip around it is the square box on art that
                      // reads as something to press.
                      <CountTag
                        count={item.count}
                        title={copies}
                        className="absolute bottom-1 left-1"
                      />
                    )
                  }
                />
              );
            })}
            {/* A short last row keeps its tiles the width of the rows above it. */}
            {Array.from(
              { length: columns - Math.min(columns, items.length - row.index * columns) },
              (_, i) => (
                <span key={`pad-${i}`} aria-hidden className="min-w-0 flex-1" />
              ),
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
