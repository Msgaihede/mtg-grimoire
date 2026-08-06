import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RarityGem } from "@/components/RarityGem";
import { cardDraggable, type DragPayload } from "@/features/decks/dnd";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import { useImageRetry } from "@/lib/useImageRetry";
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
export function columnsFor(width: number, minWidth: number = TILE_MIN_WIDTH): number {
  return Math.max(1, Math.floor((width + GAP) / (minWidth + GAP)));
}

/**
 * How wide each of those tiles is: the leftover shared out, not the minimum.
 *
 * A fixed width leaves up to one whole tile's worth of empty container at the right edge
 * — a wall of art with a 180 px gutter down one side, which reads as a rendering fault
 * rather than a layout. Stretching keeps the art flush to both edges at every window
 * size, and 5:7 is preserved because only the width is ever set.
 */
export function tileWidthFor(width: number, minWidth: number = TILE_MIN_WIDTH): number {
  if (width <= 0) return minWidth;
  const columns = columnsFor(width, minWidth);
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
  tileRef,
  dragPayload,
  minTileWidth = TILE_MIN_WIDTH,
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
   * A mark over the art's bottom-left corner — how many copies are owned, and whether a
   * wish covers the card. Over the art rather than in the caption because it is a fact about
   * the *card*, and the caption line is already a set, a number and a control at 12px.
   *
   * Nothing to say draws nothing at all, corner and backing included — whether the callback
   * returns `null` or hands over a badge that guards itself and renders nothing. On a search
   * of the whole database almost every tile has nothing to say.
   */
  badge?: (card: T) => ReactNode;
  /** The one control a tile carries, at the end of its caption. The search's quick-add. */
  action?: (card: T) => ReactNode;
  /**
   * Each drawn tile's root element, as it mounts — the seam a caller needs to make tiles
   * draggable, since a drag library is handed elements and this wall builds its own.
   *
   * A callback ref, so it may return a cleanup (React 19) and the caller's registration is
   * torn down with the tile. Nothing here uses the element: absent, this wall behaves exactly
   * as it did, and the deck editor's search panel is the only caller.
   */
  tileRef?: (card: T, element: HTMLElement | null) => void | (() => void);
  /**
   * What a tile carries when it is dragged — and, by being absent, that it cannot be.
   *
   * The wall draws the search results *and* the collection, and only the search passes one.
   * **That is a product call and this note is where it is recorded**, not a fact about the
   * tiles: a collection tile is a *card* — `CollectionPage` sums the entries behind one
   * printing into a single tile, and breaking them apart is the table's job — so a
   * `{ kind: "card" }` payload would be as honest here as it is on the collection *rows* that
   * carry one. What decided it is the enumeration this feature was built from: the drag
   * sources outside the deck editor are the search's tiles, the collection's **table rows**,
   * the pinned wishes and the pane's printings. The day the collection's wall should be one
   * too, it passes this prop and nothing else changes — which is why this is a prop rather
   * than a behaviour, one component drawing both walls, and a wall given none registers no
   * drag at all.
   *
   * Hold it still (module scope, or a `useCallback`): React detaches and re-runs a callback
   * ref whose identity changed, so a fresh arrow on every render would tear the registration
   * down and rebuild it on every scrolled row — and a source that unregisters mid-drag is a
   * drop that never arrives.
   *
   * {@link tileRef} is the lower-level seam beside it, for the one caller that registers its
   * own drag (the deck editor's docked panel, whose tiles carry a `"search-card"` because they
   * are inside the editor). **One or the other, never both.** They do not compose: the tile
   * runs the `tileRef` first and then registers its own `cardDraggable` on the *same* element,
   * and the library keeps one draggable per element in a `WeakMap` — so the second
   * registration silently replaces the caller's, either teardown unregisters the element
   * outright, and a development build logs "You have already registered a `draggable` on the
   * same element" for every tile on the wall.
   */
  dragPayload?: (card: T) => DragPayload;
  /**
   * Narrowest a tile may get here, overriding {@link TILE_MIN_WIDTH}.
   *
   * For the one wall that is not a page-width wall: the deck editor's docked panel is 384px,
   * and 384 is **331** once the panel's own left padding (12), the scrollbar (17) and this
   * wall's padding (24) are off it — measured at 330 in the running window, and 23 short of
   * two 170px tiles. At the standard floor the column drew one 330px card per row at 490px of
   * height, inside a wall 341px tall: less than a whole card, ever. The arithmetic looked fine
   * until the scrollbar and the panel's own padding were counted.
   *
   * A floor, not a width: tiles still share out the leftover ({@link tileWidthFor}), and the
   * `grid` image is 488px wide, so a smaller floor is a deeper downscale and never a blowup.
   */
  minTileWidth?: number;
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

  const columns = columnsFor(width, minTileWidth);
  const rowCount = Math.ceil(rows.length / columns);
  const tileWidth = tileWidthFor(width, minTileWidth);
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
                tileRef={tileRef}
                dragPayload={dragPayload}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

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
  tileRef,
  dragPayload,
}: {
  card: T;
  width: number;
  onSelect: (id: string) => void;
  selected: boolean;
  badge?: (card: T) => ReactNode;
  action?: (card: T) => ReactNode;
  tileRef?: (card: T, element: HTMLElement | null) => void | (() => void);
  dragPayload?: (card: T) => DragPayload;
}) {
  const mark = badge?.(card);

  // The self-healing half of the rate limit, and the reset that goes with it: this component
  // belongs to a *slot* in the grid rather than to a card, so a new search hands it a
  // different card without remounting it, and the last card's failure must not be the new
  // card's. Both live in the hook — see it for why a failed image comes back twice.
  const image = useImageRetry(cardImageUrl(card.id, 0, "grid"));

  // Held still, because React detaches and re-runs a callback ref whose identity changed —
  // so an inline arrow here would tear the caller's registration down and build it again on
  // every render of a tile, and this wall re-renders on every scrolled row. Which is also why
  // both slots below are the *caller's* to hold still: their identity is in this list.
  //
  // `card` is a dependency, and that is what keeps a tile's drag honest. This wall hands a
  // slot a different card without remounting it, and both registrations below close over the
  // `card` of the render that made them — the payload thunk defers the *call* to `dragstart`,
  // it cannot reach a card this closure was never built with. A new card is therefore a new
  // `attach`, which React detaches and re-runs: the old registration comes down and the new
  // one goes on over the card the tile is drawing now. Drop `card` from the deps and every
  // scrolled-onto tile drags whatever it drew first.
  const attach = useCallback(
    (element: HTMLElement | null) => {
      const detach = tileRef?.(card, element);
      if (!element || !dragPayload) return detach;
      const stop = cardDraggable({ element, payload: () => dragPayload(card) });
      return () => {
        stop();
        detach?.();
      };
    },
    [tileRef, dragPayload, card],
  );

  return (
    // A wrapper rather than one big button: the caption now carries a control of its own,
    // and a button inside a button is invalid HTML that React warns about and browsers
    // render as they please. The art is the button; the quick-add is its neighbour.
    <div ref={attach} style={{ width }} className="group flex shrink-0 flex-col gap-1">
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
            {image.src ? (
              <img
                // The name, not "card image": this string is what a screen reader announces
                // and what shows when a fetch fails, and both readers want the card.
                alt={card.name}
                src={image.src}
                // 117 k results is 117 k requests if every mounted tile fetches eagerly. The
                // virtualizer bounds the DOM; this bounds what the DOM asks for.
                loading="lazy"
                decoding="async"
                // An `<img>` is draggable by default, and the browser picks the *nearest*
                // draggable ancestor as a drag's source — so the art would start a drag of
                // itself and the tile's own drag (the deck editor's, through `tileRef`) would
                // never begin. Off here rather than at the caller, because the caller is
                // handed the tile and cannot reach this. Nothing is lost: an `mtgimg:` URL
                // means nothing outside this window.
                draggable={false}
                onError={image.onError}
                className="size-full object-cover transition-transform duration-150 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              />
            ) : (
              // A tile with no art is still a card. The name is what the reader came for and
              // it is known without the image, so a rate-limited screen reads as a list of
              // cards rather than a wall of broken-image icons.
              <span className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center">
                <span className="line-clamp-3 text-xs">{card.name}</span>
                <span className="text-[0.7rem] text-dim">
                  {image.retrying ? "Retrying…" : "No image"}
                </span>
              </span>
            )}
          </span>
        </button>
        {mark && (
          // The corner *and* the backing are the wall's, not the mark's: a mark sits on a
          // photograph, so it needs something behind it to be readable at all — and that
          // something is the app's own table felt at 85%, which is the quietest thing that
          // can sit on a card without becoming a sticker. Deciding it here is what keeps two
          // views from drifting into two corners and two shades.
          //
          // `pointer-events-none`: the whole tile opens the card, and a mark that swallowed
          // the click over its own two square centimetres would be a dead spot in the wall.
          //
          // `empty:hidden` is what makes "a mark with nothing to say draws nothing" true. A
          // badge that guards *itself* still hands this slot a truthy element — React has no
          // way to ask an element what it will render — so a wall of unowned tiles was a wall
          // of empty 12×4px chips. The guard belongs here, where the corner is decided, and
          // then it holds for every caller instead of for the ones that remembered.
          <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5 empty:hidden">
            {mark}
          </span>
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
