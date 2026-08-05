import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RarityGem } from "@/components/RarityGem";
import { CARD_ASPECT, cardImageUrl, imageRetryDelayMs, IMAGE_RETRY_LIMIT } from "@/lib/images";
import { cn } from "@/lib/utils";
import { needsNextPage } from "./useCardSearch";

/**
 * What a wall of art needs to know about a card: enough to draw it, name it and caption it.
 *
 * `CardSummary` satisfies this structurally and so does a mapped `CollectionRow`, which is
 * the whole point — the collection view shows the same wall over rows the search has never
 * heard of. Anything a *particular* wall needs beyond this arrives through {@link CardGrid}'s
 * two slots rather than by widening this shape: the quick-add needs `finishes` and an oracle
 * id that a collection row simply does not have, and a tile that guessed at them would offer
 * a nonfoil entry for a foil-only printing.
 */
export interface GridCard {
  id: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string | null;
}

/**
 * Narrowest a tile is allowed to get, in px — the number that decides how many columns
 * fit. Tiles then share out whatever is left over (see {@link tileWidthFor}), so this is
 * a floor rather than the width. A `grid` image is 488 px wide, so even a stretched tile
 * is a downscale, never a blowup.
 */
const TILE_MIN_WIDTH = 170;

/** Gap between tiles, matching the `gap-3` used elsewhere. */
const GAP = 12;

/**
 * The caption line under each tile, plus its `gap-1`.
 *
 * Set by the quick-add button in it (24px) rather than by the text beside it (16px): the
 * virtualiser positions rows from this number, and a caption taller than it is a wall whose
 * rows overlap by the difference.
 */
const CAPTION_HEIGHT = 28;

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
 * A list of cards as a wall of art — search results, or a collection.
 *
 * Virtualised by *row*, not by tile: the virtualizer measures a list, and a grid is a
 * list of rows that each hold `columns` cards. An unfiltered browse is ~117 k cards, so
 * the alternative is 117 k DOM nodes.
 *
 * The tiles are full card images (the `grid` variant), which is also what keeps this view
 * inside Scryfall's image policy without a separate credit line: the artist's name is
 * printed on the card. An art crop here would need one.
 */
export function CardGrid<T extends GridCard>({
  rows,
  onSelect,
  onNeedNextPage,
  listKey,
  selectedId = null,
  label = "Search results",
  badge,
  action,
}: {
  rows: T[];
  onSelect: (cardId: string) => void;
  onNeedNextPage: () => void;
  /** Identity of the current list — a search, or a filtered collection — so a new one
   *  starts at the top. */
  listKey: string;
  /** The card the detail pane is showing, so the wall can say which one that is. */
  selectedId?: string | null;
  /** What the wall is, for anyone who cannot see that it is a wall of cards. */
  label?: string;
  /**
   * A mark over the art's bottom-left corner — how many copies are owned, in the collection.
   * Over the art rather than in the caption because it is a fact about the *card*, and the
   * caption line is already a set, a number and a control at 12px.
   */
  badge?: (card: T) => ReactNode;
  /** The one control a tile carries, at the end of its caption. The search's quick-add. */
  action?: (card: T) => ReactNode;
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

  // A new list reuses this scroll container, and a browser clamps the old offset into
  // the new content rather than resetting it.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [listKey, virtualizer]);

  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label={label}
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
            // The row a quick-add is open in comes to the front. Its `transform` makes it a
            // stacking context, so the popup's own `z-20` cannot lift it above the *next*
            // row — which paints later simply for being later in the DOM, and would cover
            // the popup with the tiles below it. `:has` keeps that fact where the stacking
            // context is, rather than threading "is a popup open in me" up through a tile.
            className="absolute inset-x-0 top-0 flex gap-3 has-[[aria-expanded=true]]:z-10"
            style={{ height: tileHeight, transform: `translateY(${v.start}px)` }}
          >
            {rows.slice(v.index * columns, v.index * columns + columns).map((card, i) => (
              // Keyed by slot rather than by card id: two pages fetched either side of a
              // sync can carry one printing twice, and a duplicate key drops a card.
              <Tile
                key={`${v.index}-${i}`}
                card={card}
                width={tileWidth}
                onSelect={onSelect}
                selected={card.id === selectedId}
                badge={badge}
                action={action}
              />
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
function Tile<T extends GridCard>({
  card,
  width,
  onSelect,
  selected,
  badge,
  action,
}: {
  card: T;
  width: number;
  onSelect: (id: string) => void;
  selected: boolean;
  badge?: (card: T) => ReactNode;
  action?: (card: T) => ReactNode;
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
    // A wrapper rather than one big button: the caption now carries a control of its own,
    // and a button inside a button is invalid HTML that React warns about and browsers
    // render as they please. The art is the button; the quick-add is its neighbour.
    <div style={{ width }} className="group flex shrink-0 flex-col gap-1">
      {/* The badge is a *sibling* of the button, not a child of it: inside, its text would
          join the button's accessible name, and a wall of forty cards would be forty
          buttons called "Lightning Bolt 3 in your collection". */}
      <div className="relative">
        <button
          type="button"
          onClick={() => onSelect(card.id)}
          // The name is the card and nothing else — the quick-add beside it says what it
          // does to the card, and two buttons whose names both start with it would be two
          // buttons a screen reader cannot tell apart in a wall of forty.
          className={cn("block w-full rounded-lg text-left", FOCUS)}
        >
          <span
            className={cn(
              "block w-full overflow-hidden rounded-lg bg-surface",
              // Which card the open pane is about. A ring, because gold says "focus" as an
              // outline and "state" as a ring everywhere else in the app — and it hugs the
              // art rather than standing off it, so the wall keeps its rhythm.
              selected && "ring-2 ring-accent",
            )}
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
                <span className="text-[0.7rem] text-dim">
                  {state === "waiting" ? "Retrying…" : "No image"}
                </span>
              </span>
            )}
          </span>
        </button>
        {badge && (
          // `pointer-events-none`: the whole tile opens the card, and a mark that swallowed
          // the click over its own two square centimetres would be a dead spot in the wall.
          <span className="pointer-events-none absolute bottom-1 left-1">{badge(card)}</span>
        )}
      </div>

      {/* The gem carries no word here — a tile has room for a set and a number and nothing
          else. `RarityGem` keeps the rarity in the accessible name anyway, which is what
          the tile's own `title` attribute used to be standing in for badly. */}
      {/* `relative` is what the popup below hangs from: 256px of controls anchored to a
          170px tile has to open from the tile's *left* edge, or the first column's popup
          starts left of the scroller — and left overflow, unlike right, cannot be scrolled
          back into view. */}
      <span className="relative flex items-center gap-1.5 font-mono text-xs text-dim">
        <RarityGem rarity={card.rarity} />
        <span className="min-w-0 flex-1 truncate">
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
        {/* Whatever the caller hangs here — the search's quick-add, anchored to this
            caption. The tile does not build it, because what a control needs to be honest
            (which finishes this printing exists in, which oracle card it is of) is on the
            search's row and on no other. */}
        {action?.(card)}
      </span>
    </div>
  );
}
