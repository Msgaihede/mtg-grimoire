import { useEffect, useRef } from "react";
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
  /** Copies. Drawn as a tag on the art only above one. */
  count: number;
  /** The tile's accessible name — the card and its printing, so two printings are two names. */
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
  /** Asked when the reader nears the end of `items`. The page decides whether there is more. */
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

  // A row's height follows the wall's width; tell the virtualiser when it moves.
  useEffect(() => {
    rows.measure();
  }, [rows, rowHeight]);

  // A different list starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  const drawn = rows.getVirtualItems();
  const lastDrawn = drawn.length > 0 ? drawn[drawn.length - 1].index : -1;

  useEffect(() => {
    if (onNearEnd && rowCount > 0 && lastDrawn >= rowCount - NEAR_END_ROWS) onNearEnd();
  }, [onNearEnd, lastDrawn, rowCount]);

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
            {items.slice(row.index * columns, row.index * columns + columns).map((item) => (
              <CardTile
                key={item.key}
                className="min-w-0 flex-1"
                cardId={item.cardId}
                name={item.name}
                rarity={item.rarity}
                chin={item.chin}
                finish={item.finish}
                money={item.money}
                pressLabel={item.pressLabel}
                onPress={() => onOpen(item)}
                overlay={
                  item.count > 1 ? (
                    <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
                      <CountTag count={item.count} title={`${item.count} copies`} />
                    </span>
                  ) : undefined
                }
              />
            ))}
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
