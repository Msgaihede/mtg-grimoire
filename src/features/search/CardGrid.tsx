import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CardArt } from "@/components/CardArt";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { RarityGem } from "@/components/RarityGem";
import { cardDraggable, type DragPayload } from "@/features/decks/dnd";
import { cardScaleVars, CONTROL_SHRINK, scaled, type ZoomSection } from "@/lib/cardZoom";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
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
 * How wide a tile is at 100%, in px — **the width itself, not a floor** (changed 2026-08-14).
 *
 * The reader's zoom multiplies this and the answer is what a tile is drawn at:
 * `scaled(this, cardZoom)`. How many fit across is then a consequence rather than an input —
 * `columnsFor` divides the wall by it — and whatever the last column does not use is split
 * either side of the row ({@link sideGutterFor}).
 *
 * **This reverses the arrangement that was here until 2026-08-14**, where the zoom moved a
 * *floor*, the floor moved the column count, and the tiles then stretched to share out the
 * leftover so the wall reached both edges. Flush was the argument and it cost the gesture its
 * meaning: a stretched tile's width is a function of the **column count**, which is a step
 * function of the zoom, so most stops drew exactly what the stop before them drew. Measured on
 * the deck editor's docked column — 331px of wall, a 150px base — the ten stops of `ZOOM_STEPS`
 * collapsed to **three** distinct card widths: 102, 102, 159, 159, 159, 331, 331, 331, 331, 331.
 * Seven of the ten gestures moved nothing on screen, which reads as an app that has stopped
 * listening. Sized directly, the same column answers all ten.
 *
 * A `grid` image is 488px wide, so 2× (340px here, 300px in the deck panel) is still a
 * downscale — the only way to pass it is {@link tileWidthFor}'s clamp on a wall too narrow for
 * one whole tile, which is one soft picture at the far end of the range rather than a wall of
 * them.
 */
const TILE_BASE_WIDTH = 170;

/** Gap between tiles, matching the `gap-3` used elsewhere. */
const GAP = 12;

/** The quick-add trigger's own square at 100% zoom, before `CONTROL_SHRINK` takes its bite. */
const CAPTION_CONTROL = 24;

/** The tile's `gap-1` between the art and the strip under it, counted into the budget below. */
const CAPTION_GAP = 4;

/**
 * The caption line under each tile, plus its gap.
 *
 * Set by the quick-add button in it rather than by the text beside it: the virtualiser positions
 * rows from this number, and a caption taller than it is a wall whose rows overlap by the
 * difference. **Derived rather than written down**, because the button it is a budget for is no
 * longer 24px — `AddToCollectionButton` is drawn at `CONTROL_SHRINK` on a card — and the two
 * drifting apart is exactly the overlap this constant exists to prevent. Ceiling, not round, for
 * the same reason: 20.4px of button in 20px of strip is a wall that overlaps by 0.4px a row.
 *
 * **It is a measurement of what is in the strip, and the strip now scales in both directions.**
 * It used to floor — `max(base, scaled(base))` — because nothing *inside* it scaled, so a halved
 * budget was a caption taller than the row it was positioned for. Everything in it scales now (the
 * type, the gem, the button), so the floor would be a 28px strip around 6px of type at 0.5×. See
 * where it is scaled.
 */
const CAPTION_HEIGHT = Math.ceil(CAPTION_CONTROL * CONTROL_SHRINK) + CAPTION_GAP;

/**
 * How many tiles of `tileWidth` fit across `width`, counting the gap between them.
 *
 * At least one, always: a container measured at 0 (jsdom, or the frame before layout
 * settles) would otherwise divide the row count by zero and hand the virtualizer
 * `Infinity` rows. That floor is also what makes the clamp in {@link tileWidthFor}
 * necessary — one column is asserted even where one does not fit.
 */
export function columnsFor(width: number, tileWidth: number = TILE_BASE_WIDTH): number {
  return Math.max(1, Math.floor((width + GAP) / (tileWidth + GAP)));
}

/**
 * How wide each of those tiles is drawn: **the size asked for**, capped by the wall itself.
 *
 * The cap is the only arithmetic here, and it covers exactly one case — a wall too narrow for
 * one whole tile, where {@link columnsFor} has already floored at a column that does not fit.
 * Without it a 300px tile in a 206px column overflows sideways, and the deck editor is
 * `overflow-y-auto`, which computes `overflow-x` to `auto` — so it would become a horizontal
 * scrollbar across the whole deck builder, the one thing the app's 1024px floor forbids. Floored
 * rather than rounded so the clamped tile can never be the half-pixel wider that starts it.
 *
 * At two columns or more the cap cannot bind, by construction: `columnsFor` only counts a column
 * it has the width for.
 *
 * **This used to share the leftover out instead**, stretching every tile so the wall reached
 * both edges. See {@link TILE_BASE_WIDTH} for the measurement that ended it, and
 * {@link sideGutterFor} for where the leftover goes now.
 */
export function tileWidthFor(width: number, tileWidth: number = TILE_BASE_WIDTH): number {
  if (width <= 0) return tileWidth;
  return Math.min(tileWidth, Math.floor(width));
}

/**
 * What the row does not use, halved — the padding put either side of it, so the tiles sit
 * centred in the wall rather than packed against its left edge.
 *
 * A tile is its own size now rather than a share of the row, so up to one whole tile plus a gap
 * can be left over. Against one edge that reads as a rendering fault — which is the argument
 * the old stretching layout was built on, and it is still true of a *one-sided* remainder. Split
 * in two it reads as a margin: the wall stays symmetrical at every zoom, and what the reader
 * gave up for bigger cards is visible on both sides instead of looking like a column that failed
 * to draw.
 *
 * It is padding on the **row** rather than on the box around it for two reasons. The box is
 * what the `ResizeObserver` measures, so padding there would feed back into the width this is
 * computed from; and a part-full last row has to line up with the full rows above it, which
 * `justify-center` would break by centring three tiles under six.
 */
export function sideGutterFor(width: number, tileWidth: number = TILE_BASE_WIDTH): number {
  if (width <= 0) return 0;
  const columns = columnsFor(width, tileWidth);
  const drawn = tileWidthFor(width, tileWidth);
  return Math.max(0, (width - (columns * drawn + (columns - 1) * GAP)) / 2);
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
  zoomSection,
  selectedId = null,
  label = "Search results",
  badge,
  topLeft,
  finish,
  gameChanger,
  action,
  cardMenu,
  cardMenuKey,
  tileRef,
  dragPayload,
  baseTileWidth = TILE_BASE_WIDTH,
}: {
  rows: T[];
  onSelect: (cardId: string) => void;
  onNeedNextPage: () => void;
  /** Identity of the current list — a search, or a filtered collection — so a new one
   *  starts at the top. */
  listKey: string;
  /**
   * Which of the app's card sections this wall *is* — the key the reader's zoom is stored
   * under, and the section a ctrl+wheel here writes to. Both ends of the zoom read it: the
   * size drawn, and the size the gesture changes.
   *
   * **Required, and deliberately not defaulted.** One component draws three of the four
   * sections — the search's wall, the collection's wall and the deck editor's docked search
   * column — so a default would hand a caller who never thought about this some *other* wall's
   * setting by omission, silently and with nothing on screen to say so. That is precisely the
   * defect this prop exists to fix: the deck editor puts its search column beside the deck, and
   * a reader zooming the column was resizing the deck too — two questions asked in the same
   * second, answered together when only one was asked. A wall that has not said which section
   * it is has not thought about it, and the compiler is the cheapest place for that to surface.
   */
  zoomSection: ZoomSection;
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
  /**
   * A mark over the art's **top-left** corner — the search's printing count.
   *
   * Its own slot rather than a second `badge`, because each corner of a tile has exactly one
   * owner and drift is what happens when they do not: bottom-left the owned/wishlist badge,
   * top-right the finish chip and the game-changer crown, top-left this.
   *
   * **It is the same box as `badge` now, backing included** (2026-08-15). It carried none for a
   * day, because the mark inside it was `CountTag` — a filled banner with its own paint, which
   * the wall's `bg-bg/85` behind it would have framed twice. The search says the count in words
   * instead (`"12 printings"`), and words on a photograph need what every other mark on this
   * tile needs: the app's own table felt at 85 %, decided here so two views cannot drift into
   * two shades. The rest of the corner's rules are unchanged and are the badge's — the click of
   * its own that opens the card (see the corners in {@link Tile}), and `empty:hidden` so a mark
   * with nothing to say draws nothing.
   */
  topLeft?: (card: T) => ReactNode;
  /**
   * The finish a tile's card **is** — a holo sheen and a corner chip, drawn by `CardArt`.
   *
   * A callback rather than a field on {@link GridCard}, for that interface's stated reason:
   * the search's rows carry `finishes` and a mapped collection row does not, and a tile that
   * guessed would mark the wrong cards. Absent means no wall is marked, which is how the
   * collection's wall behaves until it has an answer worth drawing.
   *
   * Hold it still (module scope, or a `useCallback`) — see {@link dragPayload}.
   */
  finish?: (card: T) => Finish | null;
  /**
   * Whether a tile's card is one of the cards the Commander bracket counts — a small gold
   * crown, drawn by `CardArt` in the **same top-right chip** as the finish mark beside it.
   *
   * A callback for {@link finish}'s reason and not a field on {@link GridCard}: the search's
   * rows carry the fact and a mapped collection row does not, so a wall that guessed would
   * crown nothing or everything. Absent means no tile is crowned.
   *
   * Unlike `finish` this answers a plain `boolean` rather than a nullable word — the backend
   * flattens `cards.game_changer`'s NULL into `false` (`CardSummary.gameChanger` in
   * `src/lib/ipc.ts`), so there is no "unknown" arm for a caller to express.
   *
   * Hold it still (module scope, or a `useCallback`) — see {@link dragPayload}. A fresh arrow
   * per render tears every tile's drag registration down and rebuilds it on every scrolled row.
   */
  gameChanger?: (card: T) => boolean;
  /** The one control a tile carries, at the end of its caption. The search's quick-add. */
  action?: (card: T) => ReactNode;
  /**
   * What a tile offers on a right-click — **a ready-made `onContextMenu` handler**, not a list
   * of rows.
   *
   * The wall draws three surfaces: the search's results, the collection, and the deck editor's
   * docked panel. The first two offer the card menu and the third offers that menu plus the
   * editor's own rows, so the *items* cannot be decided here — and neither can the writes
   * behind them, which are each page's own. Taking the handler already built (`menu(() =>
   * buildCardMenu(target, deps))`, from `useContextMenu`) keeps every one of those decisions at
   * the surface and leaves this file with no knowledge of menus at all beyond where a
   * right-click lands.
   *
   * It lands on the **tile**, which is the whole card: the art, its two corner marks and the
   * caption under it. A field inside a tile keeps the browser's own menu — the primitive tests
   * for one before it builds anything — so the quick-add's popup is unaffected.
   *
   * Absent means a tile has no menu of its own, and the reader gets the app's plain
   * suppression. Unlike the two slots below this one needs no stable identity: it is read on
   * render rather than registered, so nothing is torn down when it changes.
   */
  cardMenu?: (card: T) => (e: ReactMouseEvent) => void;
  /**
   * The same menu, from the keyboard — `menuKey`'s handler, for Shift+F10 and the ContextMenu
   * key.
   *
   * **Its own slot rather than something derived from {@link cardMenu}**, because it is a
   * different event and a different anchor: a keypress has no coordinates, so the panel opens
   * at the tile's own bottom-left instead of at a pointer that was never there. Passing one and
   * not the other is a menu half the readers in this app cannot reach — mouse-only was the
   * option that was explicitly turned down.
   *
   * It rides the tile rather than the art button so that its `currentTarget` is the whole card,
   * which is the box the panel is anchored to; keydown bubbles up from whichever control inside
   * the tile holds the caret. The primitive decides which presses count and leaves a text field
   * alone.
   */
  cardMenuKey?: (card: T) => (e: ReactKeyboardEvent) => void;
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
   * How wide a tile is here at 100%, overriding {@link TILE_BASE_WIDTH}.
   *
   * For the one wall that is not a page-width wall: the deck editor's docked panel opens at
   * 384px, and 384 is **331** once the panel's own left padding (12), the scrollbar (17) and
   * this wall's padding (24) are off it — measured at 330 in the running window, and 23 short of
   * two 170px tiles. At the standard size the column drew one 330px card per row at 490px of
   * height, inside a wall 341px tall: less than a whole card, ever. The arithmetic looked fine
   * until the scrollbar and the panel's own padding were counted.
   *
   * The `grid` image is 488px wide, so a smaller base is a deeper downscale and never a blowup.
   *
   * The reader's zoom scales *this* rather than {@link TILE_BASE_WIDTH}, so a wall given a
   * smaller base zooms by the same factor as a page-width one — 150 at 2× is 300, which is one
   * card in a 331px column with 31px of gutter split either side of it.
   */
  baseTileWidth?: number;
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

  /**
   * How big the reader wants their cards *on this wall* — the one thing about it that is theirs.
   *
   * **The value is the store's and only the key is a prop**, and that split is the whole of this
   * change. This comment used to argue the reverse: one number for every wall, three surfaces
   * zooming together, no call site involved. Three settings that drift was named as the danger
   * and it turned out to be the request — the deck editor's docked search column and the deck
   * laid out beside it are two different questions, and a gesture over one must not answer the
   * other. So the section moved out into {@link zoomSection} and the store now holds one number
   * per section (`ZOOM_SECTIONS` in `cardZoom.ts`); a reader who zooms the search really does
   * find the collection back where they left it, which is the point rather than the regression.
   *
   * The store stays where the *value* lives, and that half is not incidental either. A wall
   * holding its own zoom in `useState` would lose it on every unmount — switch the search to
   * Table view and back, leave the collection and return, collapse the deck panel and reopen it
   * — and a size the reader chose would silently reset each time. `cardZoom[zoomSection]`
   * outlives all of those, and is still session-only (see `cardZoom.ts`), so it does not follow
   * them into tomorrow.
   */
  const cardZoom = useAppStore((s) => s.cardZoom[zoomSection]);

  // Ctrl+wheel, attached to the **scroller** rather than to the sizer inside it: the scroller is
  // what the pointer is actually over, since the sizer sits inside this wall's padding and the
  // rows on top of it are positioned absolutely — so a wheel over the padding, or in the gap
  // between two rows, would miss a listener bound any further in. The listener is a native
  // non-passive one for the usual reason (it has to `preventDefault`, or the browser zooms the
  // whole window underneath it), which is what the hook is for; React registers its own wheel
  // listeners passively at the root and could not.
  useCardZoomGesture(scrollRef, zoomSection);

  // The zoom sizes **the tile**, and the column count is what falls out of it: however many of
  // that size fit across the wall with the gap between them is however many are drawn, and the
  // remainder is split either side. Scaling the given base rather than the constant is what
  // keeps the deck panel's 150 honest — that column zooms by the same factor as a page-width
  // wall does.
  //
  // **It used to move a floor and let the tiles stretch to fill the row**, which made the drawn
  // size a function of the column count and therefore a step function of the zoom: on the deck
  // panel's 331px column, seven of the ten stops on the ladder drew exactly what the stop before
  // them drew. `TILE_BASE_WIDTH` carries the measurement.
  //
  // The other way to do this would be `transform: scale()` on the tiles, and it is wrong three
  // times over: it resamples the art, it leaves the column count at 1× so the wall no longer
  // reflows to the window, and it tells the virtualiser a row is a height it is not.
  const tileSize = scaled(baseTileWidth, cardZoom);

  const columns = columnsFor(width, tileSize);
  const rowCount = Math.ceil(rows.length / columns);
  const tileWidth = tileWidthFor(width, tileSize);
  const gutter = sideGutterFor(width, tileSize);

  // The caption moves with the tiles in **both** directions, and the asymmetry that used to be
  // here was arithmetic rather than taste: nothing inside the caption scaled, so it was a 24px
  // button beside 12px text at every zoom, and a strip budgeted at 14px for a 0.5× wall would have
  // been a caption taller than the row the virtualiser positioned for it. Everything in the strip
  // scales now — the type, the gem, the quick-add — so the budget scales with its contents and the
  // floor would be the opposite fault: a 28px strip around 6px of type on a 85px card.
  const captionHeight = scaled(CAPTION_HEIGHT, cardZoom);
  const tileHeight = Math.round(tileWidth * (7 / 5)) + captionHeight;

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
  //
  // **A zoom arrives through this same door and needs nothing of its own**: it moves the floor,
  // the floor moves the tile, and `tileHeight` is what a row's pitch is made of. Keyed on the
  // height rather than on the zoom deliberately — a zoom step that changed neither the column
  // count nor the caption left the pitch alone, and there is nothing to remeasure.
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
            // stacking context, so the popup's own layer cannot lift it above the *next*
            // row — which paints later simply for being later in the DOM, and would cover
            // the popup with the tiles below it. `:has` keeps that fact where the stacking
            // context is, rather than threading "is a popup open in me" up through a tile.
            className={cn("absolute inset-x-0 top-0 flex gap-3", LAYER.raisedWhenPopupOpen)}
            // The gutter is padding on **every** row rather than `justify-center` on them, so a
            // part-full last row still lines its tiles up under the full rows above it — three
            // tiles centred under six is a wall that looks like it lost its grid. See
            // `sideGutterFor` for why it is not on the box around them either.
            style={{
              height: tileHeight,
              transform: `translateY(${v.start}px)`,
              paddingLeft: gutter,
              paddingRight: gutter,
            }}
          >
            {rows.slice(v.index * columns, v.index * columns + columns).map((card, i) => (
              // Keyed by slot rather than by card id: two pages fetched either side of a
              // sync can carry one printing twice, and a duplicate key drops a card.
              <Tile
                key={`${v.index}-${i}`}
                card={card}
                width={tileWidth}
                zoom={cardZoom}
                onSelect={onSelect}
                selected={card.id === selectedId}
                badge={badge}
                topLeft={topLeft}
                finish={finish}
                gameChanger={gameChanger}
                action={action}
                cardMenu={cardMenu}
                cardMenuKey={cardMenuKey}
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
  zoom,
  onSelect,
  selected,
  badge,
  topLeft,
  finish,
  gameChanger,
  action,
  cardMenu,
  cardMenuKey,
  tileRef,
  dragPayload,
}: {
  card: T;
  width: number;
  /**
   * How large the reader is drawing cards on this wall — **not** used to size anything here, only
   * published as the two custom properties every mark inside the tile reads.
   *
   * The width above is the tile's whole geometry (the art follows by aspect ratio); this is the
   * other half of it, and it exists because the marks are *shared* components. `RarityGem`,
   * `OwnedBadge` and `FinishMark` are each drawn in three tables and the card pane as well as on
   * this tile, so a prop would have to be threaded to every one of them and defaulted at the ones
   * that must hold still. An inherited variable answers it once and in the other direction — see
   * `MARK_SCALE_VAR` in `lib/cardZoom.ts`.
   */
  zoom: number;
  onSelect: (id: string) => void;
  selected: boolean;
  badge?: (card: T) => ReactNode;
  topLeft?: (card: T) => ReactNode;
  finish?: (card: T) => Finish | null;
  gameChanger?: (card: T) => boolean;
  action?: (card: T) => ReactNode;
  cardMenu?: (card: T) => (e: ReactMouseEvent) => void;
  cardMenuKey?: (card: T) => (e: ReactKeyboardEvent) => void;
  tileRef?: (card: T, element: HTMLElement | null) => void | (() => void);
  dragPayload?: (card: T) => DragPayload;
}) {
  const mark = badge?.(card);
  const corner = topLeft?.(card);
  const tileFinish = finish?.(card) ?? null;
  const finishWord = tileFinish ? FINISH_LABEL[tileFinish] : null;
  const crowned = gameChanger?.(card) ?? false;

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
    <div
      ref={attach}
      // The whole tile, rather than the art button inside it: a right-click on the caption, on
      // the printing count or on the owned badge is a right-click on the card. The handler is
      // the caller's and is already built — see {@link CardGrid}'s `cardMenu` — so a wall that
      // was given none attaches nothing at all.
      onContextMenu={cardMenu?.(card)}
      // Shift+F10 and the ContextMenu key, on the same box and about the same card. The press
      // arrives here by bubbling from whatever inside the tile holds the caret, which is the
      // art button.
      onKeyDown={cardMenuKey?.(card)}
      // **The other half of the menu, and it is not the same thing as a tab stop.**
      //
      // `menu()`/`menuKey()` hand the panel *the element their handler is attached to* as the
      // `opener`, and `ContextMenu` focuses it back twice: when Escape closes, and before every
      // row it runs. **`focus()` on a node with no `tabindex` is a no-op**, so this box being
      // reachable through the button inside it is not enough — without this the hand-back lands
      // nowhere, the panel unmounts with the caret still in it, focus drops to `<body>` and the
      // next Tab restarts from the top of the app. It is the same failure `deckCardMenuProps`
      // writes down for a deck card's `<li>`, reached here by a different route.
      //
      // **`-1` and never `0`**: a wall of forty cards must not grow forty presses on the way to
      // anything, and the art button is already the stop. `-1` is a place the caret can be
      // *put*, never one Tab travels through — the arrangement every other menu opener in this
      // app carries. Unconditional, because a tile that offers no menu is not a tile a caret is
      // ever handed back to, and a `tabIndex` that came and went with a prop would be the kind
      // of difference between two walls that nothing on screen explains.
      tabIndex={-1}
      // The width, and the two variables everything drawn on this card sizes itself against. They
      // go here rather than on the row because this is the box that *is* a card — a mark inherits
      // them wherever the caller puts it, corners and caption alike, and nothing outside a tile
      // ever sees them.
      style={{ width, ...cardScaleVars(zoom) }}
      className="group flex shrink-0 flex-col gap-[calc(0.25rem*var(--mark-scale,1))]"
    >
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
          {/* The frame, the picture, its retry and the no-art fallback all live in
              `CardArt` — five surfaces draw a card and this is the one definition of what
              that looks like. The button, the focus ring and the caption stay here, because
              they are what makes this frame a *tile* rather than a picture. */}
          <CardArt
            cardId={card.id}
            name={card.name}
            selected={selected}
            finish={tileFinish}
            gameChanger={crowned}
            hoverZoom
          />
        </button>
        {mark && (
          // The corner *and* the backing are the wall's, not the mark's: a mark sits on a
          // photograph, so it needs something behind it to be readable at all — and that
          // something is the app's own table felt at 85%, which is the quietest thing that
          // can sit on a card without becoming a sticker. Deciding it here is what keeps two
          // views from drifting into two corners and two shades.
          //
          // **`pointer-events-auto` and a click of its own, where this used to be
          // `pointer-events-none`.** The corner is a *sibling* of the button, so a
          // pointer-transparent mark let the press fall through to the art and the whole tile
          // stayed one click target — but a `title` inside an element that takes no pointer
          // events can never surface, and these marks are abbreviations (`×3`, a heart) whose
          // plain-words tooltip is the point of hovering them. So the corner takes its own
          // events and calls `onSelect` itself: the two square centimetres open the card
          // exactly as before, and are now hoverable.
          //
          // The drag is unaffected. `cardDraggable` is registered on the tile's **outer
          // wrapper** (the `attach` ref above), and these corners are inside it — a press here
          // bubbles to the same element it bubbled to when it landed on the art. The corner is
          // not marked `data-no-drag`, so it is a grab handle like the rest of the tile.
          //
          // No keyboard handler, and none is owed: the corner duplicates a fact the caption
          // already states in words and opens the card the tile's own button opens. A second
          // tab stop per tile would be forty extra presses across a wall to reach nothing new.
          // (The eslint config carries no `jsx-a11y` plugin, so nothing flags the handler
          // either — this note is the reasoning, not a suppression.)
          //
          // `empty:hidden` is what makes "a mark with nothing to say draws nothing" true. A
          // badge that guards *itself* still hands this slot a truthy element — React has no
          // way to ask an element what it will render — so a wall of unowned tiles was a wall
          // of empty 12×4px chips. The guard belongs here, where the corner is decided, and
          // then it holds for every caller instead of for the ones that remembered.
          <span
            onClick={() => onSelect(card.id)}
            // The inset, the padding and the corner are all sizes on a card at 100% zoom, and
            // scale with it — the mark inside already does, and a chip whose box held still would
            // either burst at 2× or swim in its own padding at 0.5×.
            className={cn(
              "pointer-events-auto absolute bg-bg/85 empty:hidden",
              "bottom-[calc(0.25rem*var(--mark-scale,1))] left-[calc(0.25rem*var(--mark-scale,1))]",
              "rounded-[calc(0.25rem*var(--mark-scale,1))]",
              "px-[calc(0.375rem*var(--mark-scale,1))] py-[calc(0.125rem*var(--mark-scale,1))]",
            )}
          >
            {mark}
          </span>
        )}
        {corner && (
          // The opposite corner, under the same rules as the badge above and now in the same
          // box — see `topLeft` for why each corner has exactly one owner, why this one stopped
          // being the exception, and the badge's comment for why both take their own clicks.
          //
          // It is inset by 4px rather than going flush, and that is the one thing here that is
          // not the badge's arrangement copied: the corner is a *sibling* of the button, so the
          // art's `rounded-lg` does not clip it, and a box at 0,0 would hang off the picture's
          // rounded corner. 4px is as high on the card as this mark can sit — see where the
          // search passes it for what that costs against the printed name.
          <span
            onClick={() => onSelect(card.id)}
            // The badge's box, scaled the same way — and here the scaling pays a debt the search
            // page's own comment recorded: this corner is 4px in so that it clears the art's
            // rounded edge and lands on the printed nameplate, and *because it did not scale*, by
            // 2× it had climbed out of the nameplate into the border strip above it. 4px of a
            // doubled card is 8px, which is the same place on the picture.
            className={cn(
              "pointer-events-auto absolute bg-bg/85 empty:hidden",
              "top-[calc(0.25rem*var(--mark-scale,1))] left-[calc(0.25rem*var(--mark-scale,1))]",
              "rounded-[calc(0.25rem*var(--mark-scale,1))]",
              "px-[calc(0.375rem*var(--mark-scale,1))] py-[calc(0.125rem*var(--mark-scale,1))]",
            )}
          >
            {corner}
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
      {/* The type and the gutter in it are sizes at 100% zoom: the strip's own height already
          followed the card (`captionHeight`), and 12px type inside a doubled one read as a label
          the card had outgrown — which is the whole of what the strip was budgeted to hold. The
          leading is named beside the size deliberately, because an arbitrary `text-[…]` sets the
          font size and nothing else. */}
      <span
        className={cn(
          "relative flex items-center font-mono text-dim",
          "gap-[calc(0.375rem*var(--mark-scale,1))]",
          "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
        )}
      >
        <RarityGem rarity={card.rarity} />
        <span className="min-w-0 flex-1 truncate">
          {card.setCode.toUpperCase()} · {card.collectorNumber}
          {/* The finish in words, because the art's chip is `aria-hidden` — it sits inside
              the tile's button, where any text of its own would join the button's accessible
              name and make a wall of foils forty buttons called "… Foil". Stated here
              instead, in the caption, which is a sibling of that button. */}
          {finishWord && <span className="sr-only">, {finishWord}</span>}
          {/* And the crown, for the same reason and in the same place: it shares the chip
              that the whole `aria-hidden` overlay covers, so the picture is decoration and
              this line is the statement. */}
          {crowned && <span className="sr-only">, {GAME_CHANGER_LABEL}</span>}
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
