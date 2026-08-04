import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CARD_ASPECT, cardImageUrl, imageRetryDelayMs, IMAGE_RETRY_LIMIT } from "@/lib/images";
import type { CardSummary } from "@/lib/ipc";
import { rarityColor } from "@/lib/rarity";
import { cn } from "@/lib/utils";
import { needsNextPage } from "./useCardSearch";

/**
 * Narrowest a tile is allowed to get, in px — the number that decides how many columns
 * fit. Tiles then share out whatever is left over (see {@link tileWidthFor}), so this is
 * a floor rather than the width. A `grid` image is 488 px wide, so even a stretched tile
 * is a downscale, never a blowup.
 */
const TILE_MIN_WIDTH = 170;

/** Gap between tiles, matching the `gap-3` used elsewhere. */
const GAP = 12;

/** The caption line under each tile: one line of `text-xs` plus its `gap-1`. */
const CAPTION_HEIGHT = 22;

/**
 * Keyboard focus, in the shape the rest of the app uses: an outline standing off the
 * control's edge (see `FilterBar`'s `FOCUS`). A ring would sit on the art.
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * How many tiles fit across `width`.
 *
 * At least one, always: a container measured at 0 (jsdom, or the frame before layout
 * settles) would otherwise divide the row count by zero and hand the virtualizer
 * `Infinity` rows.
 */
export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GAP) / (TILE_MIN_WIDTH + GAP)));
}

/**
 * How wide each of those tiles is: the leftover shared out, not the minimum.
 *
 * A fixed width leaves up to one whole tile's worth of empty container at the right edge
 * — a wall of art with a 180 px gutter down one side, which reads as a rendering fault
 * rather than a layout. Stretching keeps the art flush to both edges at every window
 * size, and 5:7 is preserved because only the width is ever set.
 */
export function tileWidthFor(width: number): number {
  if (width <= 0) return TILE_MIN_WIDTH;
  const columns = columnsFor(width);
  return (width - (columns - 1) * GAP) / columns;
}

/**
 * Search results as card art.
 *
 * Virtualised by *row*, not by tile: the virtualizer measures a list, and a grid is a
 * list of rows that each hold `columns` cards. An unfiltered browse is ~117 k cards, so
 * the alternative is 117 k DOM nodes.
 *
 * The tiles are full card images (the `grid` variant), which is also what keeps this view
 * inside Scryfall's image policy without a separate credit line: the artist's name is
 * printed on the card. An art crop here would need one.
 */
export function CardGrid({
  rows,
  onSelect,
  onNeedNextPage,
  searchKey,
}: {
  rows: CardSummary[];
  onSelect: (cardId: string) => void;
  onNeedNextPage: () => void;
  searchKey: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The column count is a function of the container, and a window resize changes it
  // without any scroll or render this component would otherwise hear about.
  //
  // Measured on the element the tiles actually sit in rather than on the scroller around
  // it: the scroller carries the padding, so its own width is a column-count answer that
  // is 24 px too generous.
  useEffect(() => {
    const el = rowsRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = columnsFor(width);
  const rowCount = Math.ceil(rows.length / columns);
  const tileWidth = tileWidthFor(width);
  const tileHeight = Math.round(tileWidth * (7 / 5)) + CAPTION_HEIGHT;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => tileHeight + GAP,
    // Two rows of tiles beyond the viewport, which is the prefetch: their `<img>`s mount
    // and the protocol fills the cache before the reader scrolls onto them.
    overscan: 2,
  });

  // Row heights are cached from the first `estimateSize` call, so a resize that changes
  // the column count — and with it every tile's height — has to say so, or the rows keep
  // the old pitch and overlap.
  useEffect(() => {
    virtualizer.measure();
  }, [tileHeight, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length
    ? Math.min(rows.length - 1, (virtualRows[virtualRows.length - 1].index + 1) * columns - 1)
    : -1;

  // A new search reuses this scroll container, and a browser clamps the old offset into
  // the new content rather than resetting it.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [searchKey, virtualizer]);

  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label="Search results"
      // No `tabIndex`: every tile is a button, so the scroller is reachable and
      // scrollable from the keyboard through its own contents. A tab stop on the box
      // around them would be one more press between the reader and the cards.
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border p-3"
    >
      {/* Holds the scrollbar open to the full height of the wall while the rows inside it
          are positioned absolutely — and, having no padding of its own, is the honest
          answer to how wide a row of tiles may be. The virtualiser's total counts a gap
          after the last row, which here would be padding under the wall that nothing is
          separating. */}
      <div
        ref={rowsRef}
        style={{ height: Math.max(0, virtualizer.getTotalSize() - GAP), position: "relative" }}
      >
        {virtualRows.map((v) => (
          <div
            key={v.key}
            className="absolute inset-x-0 top-0 flex gap-3"
            style={{ height: tileHeight, transform: `translateY(${v.start}px)` }}
          >
            {rows.slice(v.index * columns, v.index * columns + columns).map((card, i) => (
              // Keyed by slot rather than by card id: two pages fetched either side of a
              // sync can carry one printing twice, and a duplicate key drops a card.
              <Tile key={`${v.index}-${i}`} card={card} width={tileWidth} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * What a tile is doing about its image.
 *
 * There is no separate loading state: the empty 5:7 frame *is* the placeholder, and it is
 * already on screen: the art draws into it when the bytes arrive. A shimmer over 40 of
 * these would be the only animation on the page, in the one view whose whole argument is
 * that the art is the loudest thing in it.
 */
type TileState = "showing" | "waiting" | "failed";

/**
 * One card, as art.
 *
 * The chrome is a caption and a focus ring. The rarity is a 6px gem — the only colour in
 * the tile that is not the card's own, and a filled badge there would out-shout what it
 * annotates.
 */
function Tile({
  card,
  width,
  onSelect,
}: {
  card: CardSummary;
  width: number;
  onSelect: (id: string) => void;
}) {
  const [state, setState] = useState<TileState>("showing");
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(card.id);

  // This component belongs to a *slot* in the grid, not to a card, so a new search hands
  // it a different card without remounting it. Resetting during render is React's own
  // answer to that: an effect would paint one frame of the last card's failure over the
  // new card's art.
  if (shown !== card.id) {
    setShown(card.id);
    setState("showing");
    setAttempt(0);
  }

  // The self-healing half of the rate limit. A 429 in the image fetcher makes every
  // uncached tile fail fast with a 503 + `Retry-After`, and an `<img>` that errors once
  // stays broken for the session — so the tile comes back on its own, twice, on a
  // doubling delay that starts no sooner than the floor the protocol clamps its own
  // penalty to and is dithered so a screenful of them does not return in one tick.
  //
  // Twice, because a lockout longer than the floor swallows the first attempt whole: at
  // `Retry-After: 60` the tile comes back at ~30 s, meets a gate that is still shut, and
  // a single-shot schedule would leave it on "No image" over a lockout that ended half a
  // minute later. One timer per tile at a time either way. After the second the tile
  // waits to be asked: scrolling it out of view and back is a remount, which is a reader
  // saying "now".
  useEffect(() => {
    if (state !== "waiting") return;
    const next = attempt + 1;
    const timer = setTimeout(() => {
      setAttempt(next);
      setState("showing");
    }, imageRetryDelayMs(next));
    return () => clearTimeout(timer);
  }, [state, attempt]);

  const url = cardImageUrl(card.id, 0, "grid");

  return (
    <button
      type="button"
      onClick={() => onSelect(card.id)}
      style={{ width }}
      className={cn("group flex shrink-0 flex-col gap-1 rounded-lg text-left", FOCUS)}
    >
      <span
        className="block w-full overflow-hidden rounded-lg bg-surface"
        style={{ aspectRatio: CARD_ASPECT }}
      >
        {state === "showing" ? (
          <img
            // The name, not "card image": this string is what a screen reader announces
            // and what shows when a fetch fails, and both readers want the card.
            alt={card.name}
            // The retry is a different URL so nothing between here and the handler can
            // answer it from whatever it made of the failure. The query string is not
            // part of the path the protocol parses, so it changes nothing else.
            src={attempt === 0 ? url : `${url}?retry=${attempt}`}
            // 117 k results is 117 k requests if every mounted tile fetches eagerly. The
            // virtualizer bounds the DOM; this bounds what the DOM asks for.
            loading="lazy"
            decoding="async"
            onError={() => setState(attempt < IMAGE_RETRY_LIMIT ? "waiting" : "failed")}
            className="size-full object-cover transition-transform duration-150 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          />
        ) : (
          // A tile with no art is still a card. The name is what the reader came for and
          // it is known without the image, so a rate-limited screen reads as a list of
          // cards rather than a wall of broken-image icons.
          <span className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center">
            <span className="line-clamp-3 text-xs">{card.name}</span>
            <span className="text-[0.7rem] text-muted">
              {state === "waiting" ? "Retrying…" : "No image"}
            </span>
          </span>
        )}
      </span>

      <span className="flex items-center gap-1.5 truncate font-mono text-xs text-muted">
        <span
          aria-hidden="true"
          title={card.rarity ?? undefined}
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: rarityColor(card.rarity) }}
        />
        <span className="truncate">
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
      </span>
    </button>
  );
}
