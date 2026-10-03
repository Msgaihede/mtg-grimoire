import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { CardArt } from "@/components/CardArt";
import { CardChin } from "@/components/CardChin";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import {
  cardDraggable,
  composedDraggable,
  readDragData,
  withDragGroup,
  type DragPayload,
} from "@/features/decks/dnd";
import {
  SHELF_ID_ATTR,
  headingPlace,
  shelfCarry,
  type ShelfAnchorRequest,
} from "@/features/shelves/shelfCarry";
import { PendingSlot, ShelfRails, shelfRowKey, stickyShelfAt } from "@/features/shelves/shelfRows";
import { cardScaleVars, CHIN_RISE, chinHeight, scaled, type ZoomSection } from "@/lib/cardZoom";
import { keepCaretForCard } from "@/lib/caretWalk";
import type { Finish } from "@/lib/finish";
import type { Treatment } from "@/lib/treatment";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import {
  SHELF_INDENT_PX,
  SHELF_STICKY_HEIGHT,
  anchorPlan,
  fillShelves,
  layoutHeight,
  loadedShelves,
  rowHeight,
  rowOfTile,
  rowStartOf,
  type ShelfSection,
} from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import { useAppStore } from "@/lib/store";
import { NO_SELECTION, suppressRangeSelection, useCardSelection } from "@/lib/useCardSelection";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import { nextGridIndex, nextShelfTileIndex } from "./gridNav";
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
  /**
   * The printing this tile draws — the art fetched, the card opened, and what `selectedId` is
   * compared against.
   *
   * **`""` is a row with no printing at all**, and it is the one value that is not an id: the
   * wishlist's wall draws a wish whose card has left the database, which the app still lists
   * and still names. `CardArt` is then handed `null` and draws the no-art frame — exactly what
   * the deck's Grid view passes for the same state — and the tile's own click is dead, because
   * there is nothing to open and a tile that looked pressable and did nothing would be worse
   * than one that does not. Every other caller has an id for every row and never meets it.
   */
  id: string;
  /**
   * This tile's identity, where it differs from the card's. Defaults to {@link id}.
   */
  key?: string;
  /**
   * Which open card rings this tile, where that is wider than the tile itself. Defaults to the
   * tile's own key ({@link key}, then {@link id}).
   *
   * **The collection's shelves are why this exists** (spec 2026-09-26 §5.6). A tile there is one
   * printing and finish *in one folder*, so one printing filed in two folders is two tiles with two
   * keys — and opening it has to ring both, because the pane shows the card and not the folder. The
   * collection passes the card-and-finish key here and the per-folder key as {@link key}.
   *
   * **Only the ring reads it.** The picked set, the arrow walk and the drag stay on the tile key,
   * because a Ctrl-click picks *this* tile on *this* shelf and not every copy of the card on screen.
   */
  ringKey?: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string | null;
}

/**
 * A tile's identity, which is **not always its card's**.
 *
 * The collection draws one tile per printing *and finish* — a foil and a played nonfoil are two
 * objects at two prices sharing only a set and a number — so two tiles there carry one `id`. The
 * ring, the arrow walk's caret and the picked set are about the *tile*; `onSelect` and the art are
 * about the *printing*. Six of the seven walls pass no `key` at all and are untouched.
 */
const tileKey = <T extends GridCard>(card: T): string => card.key ?? card.id;

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
 * the deck editor's docked column — 331px of wall, a 150px base — the ladder of the day (ten
 * uneven stops) collapsed to **three** distinct card widths: 102, 102, 159, 159, 159, 331, 331,
 * 331, 331, 331. Seven of the ten gestures moved nothing on screen, which reads as an app that
 * has stopped listening. Sized directly, the same column answers every stop — which is why the
 * ladder could grow to sixteen even stops on 2026-08-22 without this arrangement changing.
 *
 * A `grid` image is 488px wide, so 2× (340px here, 300px in the deck panel) is still a
 * downscale — the only way to pass it is {@link tileWidthFor}'s clamp on a wall too narrow for
 * one whole tile, which is one soft picture at the far end of the range rather than a wall of
 * them.
 */
const TILE_BASE_WIDTH = 170;

/** Gap between tiles, matching the `gap-3` used elsewhere. */
const GAP = 12;

/**
 * The wall's own `p-3`: how far into a **bounded** wall's scroll content its first row starts. The
 * virtualiser does not know about it (its `scrollMargin` is 0 there), so the sticky bar's edge is
 * corrected by it; under `grow` the measured `scrollMargin` already includes it.
 *
 * That correction assumes the bar is flush with the top of the scrollport (or with the foot of a
 * docked bar `stickyTop` below it, which the edge adds back), which a plain
 * `sticky top-0` is **not** in Chromium — it pins at the scroller's padding edge, 12px down here.
 * The anchor's measured negative `top` is what makes it flush; see `stickyInset` in `CardGrid`.
 */
const WALL_INSET_PX = 12;

/**
 * How many commits a caret chasing its tile after a column change waits for the tile to be drawn
 * (`caretChase` in `CardGrid`). The commits it has to outlast are few and known — the zoom's
 * `measure()`, the scroll's event, the virtualiser's is-scrolling flag going up and down — so a
 * small number is enough, and a bound at all is what keeps a tile that never arrives from pulling
 * the caret back long after the reader has moved on.
 */
const CARET_CHASE_COMMITS = 8;

/**
 * The nearest ancestor that actually scrolls, for a wall drawn with {@link CardGrid}'s `grow`.
 *
 * A growing wall has no scrollport of its own, and the virtualiser has to be told which box the
 * rows are being scrolled *through* — on the search page that is `AppShell`'s `main`, the one
 * scroller the app has above a view. Walking the tree for it rather than taking it as a prop is
 * what keeps the answer honest through a layout change: nothing has to thread a ref down four
 * components, and a wall that is later moved inside some other scroller finds that one instead.
 *
 * **`null` means "nothing above this scrolls", and the caller falls back to the wall itself.**
 * That is not a defensive shrug: it is the state every test is in. jsdom applies no stylesheet, so
 * `overflow-y` computes to the empty string on `main` exactly as it does on a plain `<div>` — the
 * walk can never find a scroller under vitest, and without the fallback a growing wall would draw
 * zero tiles in every test that renders one.
 */
function nearestScroller(from: HTMLElement | null): HTMLElement | null {
  for (let el = from?.parentElement ?? null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return null;
}

/**
 * A tile's **absolute** position in `rows`, published on its own root element.
 *
 * The DOM is the caret's data structure here, exactly as it is for the context menu's rows
 * (`components/menu/panel.ts` argues the same point at greater length): a keypress arrives with
 * a `target`, and walking up from it to the tile it landed in is one `closest` — where mapping
 * that element back to a *card* through the `rows` array would mean keeping a second index of
 * something the browser is already holding.
 *
 * It goes on the tile's root rather than on the art button inside it because a press can land on
 * any of a tile's parts — the art, either corner mark, the action strip over the art, the chin
 * under it — and only the root contains all of them. The element that eventually takes the caret is a different
 * one; see {@link CARET_SELECTOR}.
 *
 * **Absolute, not (row, column).** Selecting a card opens the 384px detail pane, `columnsFor`
 * divides what is left, and the wall re-flows *as a result of the very press being handled* — so
 * a tile's row and column are answers with a shelf life of one render and its absolute index is
 * not. Every step of the move is keyed off this number for that reason: the arithmetic in
 * `gridNav.ts`, the tile the effect below hunts for, and the scroll that has to reach it.
 *
 * Written unconditionally rather than only under {@link CardGrid}'s `arrowNav`, because it
 * states a fact about the tile rather than about a feature — a conditional attribute would be a
 * second thing to keep in step with the prop, for nothing: nothing reads it unless the handler
 * is armed.
 *
 * **On a sectioned wall it is the tile's slot in the layout's flat order** — the `[start, end)`
 * runs `layoutShelves` hands out, which is what `nextShelfTileIndex` and `rowOfTile` count in. It
 * equals the tile's place in `sections.flatMap(tilesOf)` whenever each shelf's loaded tiles fill
 * its first slots, which is the ordinary case because pages arrive in shelf order. It keeps
 * counting correctly when they do not, which the loaded order alone could not: a shelf whose count
 * is ahead of its pages leaves holes, and every shelf after it would otherwise be numbered short.
 */
const GRID_INDEX_ATTR = "data-grid-index";

/** The same spelling as a selector, written out so it reads as one string rather than as two. */
const TILE_SELECTOR = "[data-grid-index]";

/**
 * What inside a tile takes the caret when an arrow key moves the selection: the art button.
 *
 * The tile's root is focusable (`tabIndex={-1}`, so a menu can hand the caret back to it) and is
 * deliberately **not** what is focused here. It is a place the caret can be *put* and never one
 * Tab travels through, and it wears no focus ring — the ring is `FOCUS` on the button. A reader
 * arrowing across the wall with nothing visibly focused would be worse than no arrow keys at
 * all.
 *
 * The art button is a tile's first `<button>` in document order, and that survived the caller's
 * control moving out of the chin: the two corner marks are `<span>`s, and the action strip is the
 * **last** child of the same box the art button opens — so it is still after it. `?? tile` is the
 * fallback for a wall drawn without art at all, which no caller builds today.
 */
const CARET_SELECTOR = "button";

/**
 * A press that belongs to a caret in a field rather than to the wall.
 *
 * **Deliberately wider than `isTextEntry` in `components/menu/panel.ts`**, and the two must stay
 * apart for the reason that file already gives about its own pair: that predicate governs which
 * keys an open *menu* yields, and denies `checkbox`, `radio` and `range` because the arrows mean
 * nothing on them there. Here every `<input>` counts, plus `<select>`, because a radio group or
 * a range slider uses the arrow keys *itself* — a wall that jumped the selection while somebody
 * was nudging a slider would be taking a key the control was using.
 *
 * It is the general statement of a rule the handler then makes tighter: a press is only a walk
 * when the caret is on the tile itself, which excludes every field on the page whether or not it
 * is named here. Both are kept because they fail in opposite directions — this one is a
 * deny-list that survives any later loosening of *where* a walk may start from, and that one
 * covers the controls a deny-list of input types cannot see (the quick-add popup's buttons).
 */
const FIELD_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/** What can take the caret in a wall's row — the first one of these in the first drawn row is
 *  where Top hands the caret when its scroll takes the sticky bar away. */
const FIRST_CONTROL = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * What Tab can currently land on inside a tile — the controls a caller hangs in its slots, which
 * a tile that is not the wall's stop takes out of the Tab order (see `tabStop` on {@link Tile}).
 * `FIRST_CONTROL`'s list, narrowed to what is not already `-1`.
 */
const TABBABLE = ":is(button, [href], input, select, textarea, [tabindex]):not([tabindex='-1'])";

/**
 * Set on a caller's control while its tile is not the stop, holding the `tabindex` it had before
 * (`""` for none) so the stop's return can put back exactly that.
 */
const HELD_TAB_ATTR = "data-roving-held";

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
 * The wall drawn as **shelves** — one heading per folder with that folder's tiles under it, nested
 * to any depth (spec 2026-09-26 §5.2). Handed to {@link CardGrid} as `sections`; absent, the wall is
 * the flat one.
 *
 * The wall owns the geometry and the page owns every word: the headings, the empty boxes, the
 * `Decks` / `Managed by decks` labels and the sticky bar are the caller's render props, so the
 * collection and the wishlist draw their own (`features/shelves/`: `ShelfHeading`, `EmptyShelf`,
 * `ShelfLabel`, `ShelfStickyBar`) and this file knows nothing about folders beyond `Shelf`'s shape.
 *
 * **Hold `sections` and `tilesOf` still** (a `useMemo` at the call site): the layout is keyed on
 * those two, and a fresh one per render is a new layout per render. The four render props are read
 * at draw time and may be fresh arrows.
 */
export interface GridSections<T extends GridCard> {
  /** Every shelf to draw, in order, with its tile count from the page's shelf counts. */
  sections: readonly ShelfSection[];
  /** The tiles one shelf has loaded, in order. Keys must be unique across shelves. */
  tilesOf: (shelfId: number) => readonly T[];
  renderHeading: (shelf: Shelf) => ReactNode;
  renderEmpty: (shelf: Shelf) => ReactNode;
  renderLabel: (group: "decks" | "managed") => ReactNode;
  /**
   * The bar over the top of the wall (spec §5.3) — `shelf` is the one the reader is scrolled
   * inside, or `null` when there is none to name; `scrollToTop` is the bar's **Top**, held still.
   */
  renderSticky: (shelf: Shelf | null, scrollToTop: () => void) => ReactNode;
  /**
   * **A shelf to bring into view** — its heading row, or its first row if it is headless — the
   * moment this *changes* to its id. Pages set it when **Add folder** opens a placeholder heading,
   * so the name field being typed into is never below the fold.
   *
   * Scrolled once per id: a later re-render carrying the same id (a page landing, a count
   * refetch) does not drag the reader back to it. An id the layout does not hold, and `null`, do
   * nothing — a shelf deleted in another window is not an error.
   */
  revealShelfId?: number | null;
}

/** The four keys `nextShelfTileIndex` answers, as a guard over a `KeyboardEvent.key`. */
type ShelfArrow = Parameters<typeof nextShelfTileIndex>[2];
function isShelfArrow(key: string): key is ShelfArrow {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
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
  badgeChrome = "chip",
  topLeft,
  topLeftPlacement = "nameplate",
  bottomRight,
  finish,
  treatment,
  gameChanger,
  action,
  column,
  caption,
  money,
  cardMenu,
  cardMenuKey,
  tileRef,
  dragPayload,
  dragRecord,
  arrowNav = false,
  selectionScope,
  baseTileWidth = TILE_BASE_WIDTH,
  grow = false,
  sections,
  stickyTop = 0,
}: {
  /** The cards to draw — **not drawn under {@link sections}**, which lays out its own. */
  rows: T[];
  /**
   * Open the card a tile is about.
   *
   * **The row is passed beside the id**, because a tile is not always a printing: the collection
   * draws one per printing *and finish*, and the pane has to be told which of the two the reader
   * pressed. The id stays first because that is what every other wall opens with.
   */
  onSelect: (id: string, card: T) => void;
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
  /**
   * Which tile wears the ring — the card the detail pane is showing, so the wall can say which
   * one that is.
   *
   * **It is compared against {@link tileKey}, not against `card.id`**, and on a wall that passes
   * `key` those are different strings. `tileKey` is `card.key ?? card.id`, so the six walls whose
   * rows carry no `key` go on passing a printing id and are untouched — but a wall that splits one
   * printing into several tiles (the collection draws one per printing *and finish*) must pass the
   * **key of the tile it means**, not the id of the card behind it. A card id there matches no
   * tile's key and rings nothing at all, silently: there is no type to catch it, because both are
   * `string`.
   *
   * The same is true of the picked set, which is keyed the same way — see {@link selectionScope}.
   *
   * **Or against `card.ringKey`, where a tile carries one** — the collection's shelves, where one
   * printing filed in two folders is two tiles with two keys and opening it rings both. A tile with
   * no `ringKey` is compared exactly as above, which is every tile on the other walls.
   */
  selectedId?: string | null;
  /** What the wall is, for anyone who cannot see that it is a wall of cards. */
  label?: string;
  /**
   * A mark over the art's bottom-left corner — how many copies are owned, and whether a
   * wish covers the card. Over the art rather than in the chin because it is a fact about
   * the *card*, and the chin is already a gem, a printing, a finish and a price at 10px.
   *
   * Nothing to say draws nothing at all, corner and backing included — whether the callback
   * returns `null` or hands over a badge that guards itself and renders nothing. On a search
   * of the whole database almost every tile has nothing to say.
   */
  badge?: (card: T) => ReactNode;
  /**
   * Whether the {@link badge} corner draws the wall's own chip behind the mark, or hands that
   * job to the mark itself. `"chip"` by default, which is every caller but one.
   *
   * **The default is the argued position and not an inherited shape.** A mark on this wall sits
   * on a *photograph*, so it needs something behind it to be legible at all; deciding what that
   * something is at the **corner** rather than at the mark is what has kept six walls from
   * drifting into six shades of backing, and it is the same sentence `topLeft` makes when it
   * says its exception ended. So the corner supplies `bg-bg/85`, the scaled radius and the
   * scaled padding, and a caller hands over plain inline content.
   *
   * **`"bare"` is the narrow exception for a corner holding *two* marks, each of which needs a
   * backing of its own** — the wishlist's, which stacks a folder pill over a copies-wanted pill
   * with a 4px gutter between them. One box around both would have to be as wide as the folder
   * name (variable) with two glyphs (`×4`) alone on the row beneath it, which is a large empty
   * rectangle laid over the art rather than a mark. What `"bare"` drops is the backing, the
   * padding and the radius and **nothing else**: the corner keeps its position, its
   * `empty:hidden`, its own pointer events and the click that opens the card, so a bare corner
   * is still the same corner. It is not licence to draw an unbacked mark on art — a caller
   * passing this owes each of its marks a backing of its own.
   *
   * **It governs the `badge` corner alone.** {@link topLeft} and {@link bottomRight} keep the
   * chip unconditionally, because both of their callers want exactly one box and the wishlist's
   * bottom-right mark is deliberately a single pill with two lines in it — the case this prop
   * exists for is two *marks*, not two lines.
   */
  badgeChrome?: "chip" | "bare";
  /**
   * A mark over the art's **top-left** corner — the search's printing count.
   *
   * Its own slot rather than a second `badge`, because each corner of a tile has exactly one
   * owner and drift is what happens when they do not: bottom-left the owned/wishlist badge,
   * top-right the finish chip and the game-changer crown, bottom-right {@link bottomRight},
   * top-left this.
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
   * Where the {@link topLeft} corner sits, because two walls want two different answers and both
   * are right.
   *
   * * **`"nameplate"`** — the default, and every wall's behaviour until 2026-08-26. Insets it 4px,
   *   clear of the art's rounded corner and onto the card's printed name, which is where the
   *   search's `N printings` count belongs: it annotates the card it is printed over, and the
   *   nameplate is the quietest strip on a photograph to put words on.
   * * **`"clear"`** — drops it below the printed title bar instead, for a mark that must not cover
   *   the card's own name. The wishlist's review flag and cost are the live case: a reader
   *   identifies a wishlist tile *by* the name, so a chip over it hides the one thing the row is
   *   about. Reported by the reader in those words.
   *
   * **The offset is on the corner's wrapper rather than on the mark inside it**, and that is not
   * an implementation detail — the wrapper carries the felt (`bg-bg/85`) and the padding, so a
   * margin on the mark grows the chip *downward from the same origin* and makes the occlusion
   * worse rather than better.
   *
   * **`2rem`, from this repo's own measurement of the frame.** `SearchPage`'s `topLeft` records a
   * printed nameplate at **roughly 8–22px** on a 238px card face (a 170px tile at 100 % zoom),
   * which is why 4px — a chip occupying 4–18px — lands on it deliberately. 32px therefore clears
   * that nameplate's bottom edge by 10px, most of a nameplate's own height, which is the margin
   * the word *roughly* in that measurement is owed and which also absorbs the layouts whose frame
   * is not the standard one (a full-art land, a saga, an adventure). It scales like everything
   * else drawn on a card: 64px on a doubled card is the same place on a doubled nameplate.
   */
  topLeftPlacement?: "nameplate" | "clear";
  /**
   * A mark over the art's **bottom-right** corner — the fourth and last of a tile's corners.
   *
   * **The exact mirror of {@link badge}, and built from the same box on purpose.** Each corner of
   * a tile has exactly one owner — bottom-left `badge`, top-left {@link topLeft}, top-right the
   * finish chip and the game-changer crown (`CardArt`'s own), bottom-right this — and the whole
   * reason all four are decided here rather than at the call sites is that four corners written
   * four times drift into four shades of felt, four insets and four radii. So this corner is the
   * badge's `bg-bg/85`, the badge's scaled radius and padding, the badge's `empty:hidden` (a mark
   * that guards itself still hands over a truthy element, so the guard has to be on the backing),
   * the badge's `pointer-events-auto` and the badge's own click that opens the card.
   *
   * **A caller passing both this and {@link action} would have the strip lying over this corner**,
   * and that is a real constraint rather than a hypothetical: the strip is `inset-x-0 bottom-0
   * justify-end`, so it spans the tile's full width at the foot of the art and puts its control in
   * exactly this corner. The one caller adding a `bottomRight` — the wishlist's wall — is dropping
   * its `action` in the same change, which is what makes the pair legal to leave uncontested here.
   * A wall that genuinely needs both owes a decision about which of the two the corner belongs to,
   * not a `z-index`.
   */
  bottomRight?: (card: T) => ReactNode;
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
   * What a tile's card is *called*, if anything — `finishTreatments` from `@/lib/treatment`,
   * drawn by `CardArt` in the **same chip** as {@link finish}, whose glyph and word it
   * replaces.
   *
   * A second callback beside `finish` rather than a widening of it, which is what the two
   * existing marks already do for each other's reason: they answer about different columns
   * (`finishes` and `promo_types`), a caller may honestly have one and not the other, and a
   * `{finish, treatments}` pair would make every existing call site build an object per tile
   * on every render. Absent means no tile is named, which is what a wall with no
   * `promoTypes` on its rows must draw.
   *
   * Hold it still (module scope, or a `useCallback`) — see {@link dragPayload}. A fresh arrow
   * per render tears every tile's drag registration down and rebuilds it on every scrolled row.
   */
  treatment?: (card: T) => readonly Treatment[];
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
  /**
   * The one control a tile carries — **in a strip over the bottom of the art**, since 2026-08-26.
   * The search's quick-add.
   *
   * It used to sit at the end of the caption, and there is no room for it there any more: the chin
   * is a gem, a printing line, a finish mark and a price at 170px. Over the art it costs the wall
   * no height at all (the strip is absolutely positioned, so `tileHeight` is unchanged by its
   * existence) and it is where the deck editor already puts a card's stepper.
   *
   * **It is `inset-x-0 bottom-0 justify-end`, so it lies over the {@link bottomRight} corner** —
   * the two slots contest one piece of the tile and a wall passing both owes a decision about
   * which of them owns it. No wall does today; see `bottomRight`.
   */
  action?: (card: T) => ReactNode;
  /**
   * A control standing **on end in the tile's right margin**, over the art — the deck stack's
   * position for a card's stepper, brought to the walls by issue #348.
   *
   * Its own slot rather than a second thing hung in {@link action}, for the reason every corner
   * of a tile has exactly one owner: the strip is a *row* at the foot (`justify-end`), and a
   * column standing up the right-hand side is a different piece of geometry with a different
   * collision list. Hanging both off one slot would make the caller responsible for un-picking the
   * strip's own layout, which is how two walls drift into two arrangements.
   *
   * The box is `absolute`, so it costs the wall no height and `tileHeight` is unchanged by its
   * existence — the strip's property, for the strip's reason.
   *
   * **Where it starts is not the strip's 4px**: the top-right of a tile is already the finish
   * chip and the game-changer crown (`CardArt`), so the column begins below them. 24px on
   * `--mark-scale` is that chip's own box — a 4px inset over ~14px of chip — so the two clear
   * each other at every stop of the zoom rather than at 1× only.
   *
   * **The box spans the tile and right-aligns its contents**, which is the strip's arrangement
   * for the strip's reason — a popup in here anchors off the *tile's* left edge rather than off a
   * 31px box four pixels from its right one. See the wrapper itself for the measurement; what a
   * caller has to know is that the wide box is `pointer-events-none` and each **child** inherits
   * that gate until the tile is hovered or holds focus, so a control put here must be a child of
   * this slot rather than something that positions itself out of it.
   */
  column?: (card: T) => ReactNode;
  /**
   * What the chin says about the printing, replacing the `SET · number` it says by default.
   *
   * **The wishlist's wall is why this exists, and it is a correctness slot rather than a
   * styling one.** A wish for *any* printing is drawn as one of them — the newest printing of
   * its oracle card, which is the only way it can have art at all — and a chin reading
   * "DSK · 123" under that picture would say the reader had asked for that piece of cardboard.
   * They asked for the card. So the wishlist answers "Any printing" there and the tile stops
   * claiming what the row does not say, which is the same distinction its table draws in its
   * Printing column (`features/wishlist/wish.ts`).
   *
   * The slot is the *text* and not the line: the rarity gem before it, the finish mark and
   * {@link money} after it are the chin's, and so is the `sr-only` game-changer word at the end of
   * the row — that one describes a mark over the art, which is drawn from the same tile whatever
   * this slot says. Nothing is appended to what this returns; the chin's other slots sit beside it.
   */
  caption?: (card: T) => ReactNode;
  /** What this wall's chin says one copy costs. */
  money?: (card: T) => ReactNode;
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
   * chin under it. A field inside a tile keeps the browser's own menu — the primitive tests
   * for one before it builds anything — so the quick-add's popup is unaffected.
   *
   * Absent means a tile has no menu of its own, and the reader gets the app's plain
   * suppression. Unlike the two slots below this one needs no stable identity: it is read on
   * render rather than registered, so nothing is torn down when it changes.
   *
   * **`undefined` for one tile is a tile with no menu**, which the wishlist's wall needs and the
   * other two never produce: a wish for *any* printing names no cardboard to copy a name from,
   * link to or record a copy of, so it is offered no menu at all — the rule its table already
   * applies per row, applied here to the same rows.
   */
  /**
   * The **whole picked set** reaches the builder as a second argument (issue #214), so a surface
   * whose menu acts on several cards has them in hand — and only when the right-clicked card is
   * one of them, which is what makes a right-click outside the set about the card under the
   * pointer. Empty for every ordinary press, and a caller that takes one argument is unchanged.
   */
  cardMenu?: (card: T, picked: readonly T[]) => ((e: ReactMouseEvent) => void) | undefined;
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
  cardMenuKey?: (card: T, picked: readonly T[]) => ((e: ReactKeyboardEvent) => void) | undefined;
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
   * The wall draws the search results *and* the collection, and only the search passes **this**
   * one. **That is a product call and this note is where it is recorded**, not a fact about the
   * tiles: a collection tile is a *card* — `CollectionPage` sums the entries behind one
   * printing into a single tile, and breaking them apart is the table's job — so a
   * `{ kind: "card" }` payload would be as honest here as it is on the collection *rows* that
   * carry one.
   *
   * **The collection's wall is a drag source now, and it went in through {@link dragRecord}
   * rather than through here** — which is the sentence this note used to predict ("the day the
   * collection's wall should be one too, it passes this prop and nothing else changes") landing
   * one seam to the left of where it was aimed. A tile's drag means *two* things at once: a card,
   * for the deck categories and the sidebar's Decks entry that have always taken one; and the
   * several `collection_entries` rows the wall summed into that piece of art, for a folder card.
   * Two marks in one flat record is exactly what `dragRecord` exists to carry — the wishlist's
   * tiles reached the same shape first — so the prediction was right about the wall and wrong
   * about which of the two slots it would use. Both are still props rather than behaviours, one
   * component draws both walls, and a wall given neither registers no drag at all.
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
  dragPayload?: (card: T) => DragPayload | null;
  /**
   * The same seam for a tile whose drag means **more than one thing** — the whole record the
   * adapter is handed, rather than one {@link DragPayload}. `null` still means "this tile cannot
   * be picked up"; **preferred over {@link dragPayload} where both are given**, which no caller
   * should do.
   *
   * **The wishlist's wall is why this exists, and neither of the two obvious routes reached it.**
   * A *pinned* wish is a card a deck column can take **and** a wish a folder can file, so its
   * record is `dragData`'s keys and `wishDragData`'s keys in one flat object — and `dragPayload`
   * cannot express a second mark, because it is typed to the deck drag's union and the tile then
   * calls `cardDraggable`, which hard-wires `getInitialData: () => dragData(payload())`. An
   * *any-printing* wish is worse still: it carries only the wish mark, so it has no `DragPayload`
   * at all, and `null` there is read one line below as "register nothing" — which is precisely the
   * tile that has to become draggable. Widening `DragPayload` would put a wishlist concept inside
   * the deck drag's type; registering a second `draggable()` through {@link tileRef} would give a
   * pinned wish two competing registrations on one element. So the composing is the caller's and
   * this slot is what carries the result.
   *
   * **Named `dragRecord` and not `dragData`** because `dragData` is already the exported function
   * in `features/decks/dnd.ts` that most callers of this prop will be calling *into* it, and one
   * name for both would read as a mistake at every call site.
   *
   * Everything {@link dragPayload} says about holding the callback still, and about never pairing
   * it with {@link tileRef}, is true of this one for the same reasons.
   */
  dragRecord?: (card: T) => Record<string, unknown> | null;
  /**
   * Whether the arrow keys walk the wall — left and right one tile, up and down one row — and
   * **move the selection with them**, so the card the detail surface is showing follows the
   * caret.
   *
   * That last part is what makes this a prop rather than a behaviour. Every press calls
   * {@link onSelect}, which on the two walls that pass this *is* the store's `selectedCardId` and
   * therefore what `CardDetailModal` reads — the reader asked for the next card
   * to be *selected*, not merely outlined, and a focus ring that moved while the card held still
   * would be a wall with two carets on it. So a caller who passes this is signing up for the
   * arrow keys to open cards.
   *
   * **The printings modal must never take it, and the reason is not caution.** `AllPrintingsDialog`
   * draws this same wall over one card's printings, and left/right *there* mean something else
   * entirely — stepping through the printings inside the surface the reader has already opened.
   * Two meanings for one key on one screen is not a conflict a component can arbitrate, so the
   * modal keeps its own and this wall is told nothing. The deck editor's docked search column
   * (`DeckSearchPanel`) passes nothing either, for a plainer reason: its tiles are drag sources
   * into the deck beside them, and the arrows are how a reader moves *within the deck*.
   *
   * Off by default, so the two walls that want it say so and nobody inherits it by omission —
   * the same argument {@link zoomSection} makes from the other end, where the risk was a default
   * rather than an absence.
   *
   * **It also makes the wall one Tab stop rather than one per tile** — a roving tabindex, issue
   * #558. Every tile's art is a button, so without this a keyboard reader Tabs through the whole
   * result set to reach whatever follows it. On an armed wall one tile is the stop and every
   * other is `-1`; the arrows are how the reader moves between them. **A wall without the arrows
   * keeps every tile a stop**, because there a `-1` tile would be reachable by nothing at all.
   */
  arrowNav?: boolean;
  /**
   * **Which surface this wall is, for the purpose of multi-select** — issue #214. Ctrl/⌘-click
   * builds a set of tiles, Shift-click takes a range, and a drag from any member carries the whole
   * set. Absent, and none of that exists: a plain click opens the card exactly as it always did.
   *
   * Opt-in, exactly as {@link arrowNav} is opt-in, and **`AllPrintingsDialog` passes none** for
   * that prop's own reason: a press inside the printings modal is a swap or a look, the modal
   * closes on it, and a set of printings is not a thing anything downstream can act on.
   *
   * The string is the surface's own (`search`, `collection`, `wishlist`, `tags`, `deck-panel:12`)
   * and is what keeps a set made here invisible to every other wall — see `lib/store.ts`'s
   * `cardSelection`. Two walls that could be on screen at once **must** pass different scopes:
   * that is what makes clicking a tile in the deck editor's docked panel put the deck's own
   * selection down, since a pick in a new scope replaces the whole set.
   *
   * The keys are **tile** keys — {@link tileKey}, i.e. `card.key ?? card.id` — so on the six walls
   * whose rows carry no `key` they are printing ids and a caller passes a name and nothing else.
   * A wall that splits one printing into several tiles picks each of them separately, which is the
   * point of that fallback rather than an exception to it.
   */
  selectionScope?: string;
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
  /**
   * **Grow to the whole list and let the page scroll it, instead of scrolling inside a box.**
   *
   * Off by default, and the default is the wall this component was written as: `min-h-0 flex-1
   * overflow-auto` inside a framed box that takes whatever height its surface has left. On it,
   * the wall has no scrollport, no frame and no height of its own — it is as tall as its rows,
   * and the scroller is whatever ancestor already scrolls ({@link nearestScroller}), which on a
   * page is `AppShell`'s `main`. The virtualiser is unchanged either way; only which box it
   * measures and reads an offset from moves.
   *
   * **It is opt-in per call site because "bounded" is a real property of two of them, not an
   * oversight.** The deck editor's docked panel is `MIN_PANEL_WIDTH_PX` — 206 — at its floor,
   * which is one column: a browse fetched through in there would make the editor page many
   * times taller than the deck laid out beside it, and the panel's tiles are drag *sources*
   * into that deck's category columns, which have to be on screen at the same time. And
   * `AllPrintingsDialog` is inside a `Dialog`, where the panel is clamped to the window and
   * scrolls inside itself — a modal that grows past the bottom of the window takes its own
   * controls with it, which is the one failure `Dialog`'s clamp exists to prevent.
   *
   * The frame goes with the scrollport rather than staying behind, and that is the same rule
   * read once: a border around a box is a border around something the reader can see the edges
   * of. Around a wall as tall as its list it is two vertical lines running off the top and
   * bottom of the window, which is the bounded box's look without the bounded box.
   */
  grow?: boolean;
  /**
   * **Draw the wall as shelves** — a heading per folder with that folder's tiles under it, nested
   * to any depth (spec 2026-09-26 §5.2). Absent, this is the flat wall, row for row: the search
   * page, the Tags page and the three docked search columns never pass it.
   *
   * With it, `rows` is not drawn. The virtualiser runs over `layoutShelves`' rows instead — a
   * shelf's last row may be short, two shelves never share a row, and a slot whose page has not
   * landed is an empty frame. The picked set, the arrow walk and the paging follow the layout; the
   * zoom resizes the tiles and never a heading. See {@link GridSections}.
   */
  sections?: GridSections<T>;
  /**
   * **How far below the top of the scrollport the shelf bar pins** — the height of a bar docked
   * over the scroller, so the shelf bar stacks flush under it rather than sliding beneath it; `0`
   * (the default) where nothing is docked, which is every wall but a shelved one while the filter
   * quick bar is down (spec 2026-09-29 §6.2).
   *
   * **Three things move with it, and they must move together.** The sticky anchor's `top` becomes
   * `stickyTop − stickyInset`; the edge {@link stickyShelfAt} measures from moves down by the same
   * amount — the bar names the shelf under *its own* top edge, and with 53px of quick bar over the
   * wall that edge is 53px further into the content than the scrollport's; and the virtualiser's
   * `scrollPaddingStart` grows by it, so a row a reveal, an arrow walk or a caret chase aligns to
   * the top lands under the shelf bar's foot rather than under either bar. Moving the bar and not
   * the edge would name the shelf the quick bar is covering; moving it and not the padding would
   * park every revealed row behind the two bars.
   *
   * Only a sectioned wall draws a shelf bar, so a flat wall ignores it. A number rather than a
   * boolean because the wall has no business knowing what is docked above it or how tall that is:
   * the page that docks the bar measures it and says so here.
   */
  stickyTop?: number;
}) {
  const wallRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  /**
   * The tile an arrow key has sent the caret to, held until the wall has actually drawn it.
   *
   * **This is state rather than a `focus()` on the next line because the wall is virtualised.**
   * `overscan` is 2, so the tile a press moves to is very often not in the DOM yet — a
   * `querySelector` immediately after the keydown finds nothing, and the caret drops to `<body>`
   * with the selection already moved, which is the worst of both. So the handler asks the
   * virtualiser to scroll and writes the wanted index here; the effect below picks it up once
   * the tile exists and clears it.
   *
   * `null` is "nobody is waiting", and it has to be cleared on arrival rather than left behind:
   * the effect re-runs whenever the virtual rows change, and a stale index would steal the caret
   * back from wherever the reader had since put it.
   */
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);

  /**
   * **The tile that is this wall's one Tab stop, by its tile key** — the roving tabindex an
   * {@link arrowNav} wall keeps (issue #558). Written when focus lands anywhere in a tile and when
   * an arrow moves the walk; `null` until then and after a new list.
   *
   * **A key rather than a `data-grid-index`**, for `caretChase`'s reason: an index is a position,
   * and a column change on a sectioned wall, a page landing or a new search hands that position to
   * a different card — a stop remembered by index would jump to a tile the reader never visited.
   *
   * What is remembered is not always what is drawn — see `tabStopIndex`, which is the stop the
   * render actually uses.
   */
  const [rovingKey, setRovingKey] = useState<string | null>(null);

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

  // Ctrl+wheel, attached to **the wall's own box** rather than to the sizer inside it: that box
  // is what the pointer is actually over, since the sizer sits inside this wall's padding and the
  // rows on top of it are positioned absolutely — so a wheel over the padding, or in the gap
  // between two rows, would miss a listener bound any further in. It is deliberately this element
  // and not `scroller`: under `grow` the scroller is `main`, and a ctrl+wheel over the filter bar
  // or the sidebar would then step this section's zoom from outside the wall it is about. The
  // element is also what the zoom badge is drawn over, so a wall that registered `main` would put
  // its figure in the window's corner rather than in its own. The listener is a native
  // non-passive one for the usual reason (it has to `preventDefault`, or the browser zooms the
  // whole window underneath it), which is what the hook is for; React registers its own wheel
  // listeners passively at the root and could not.
  useCardZoomGesture(wallRef, zoomSection);

  // The zoom sizes **the tile**, and the column count is what falls out of it: however many of
  // that size fit across the wall with the gap between them is however many are drawn, and the
  // remainder is split either side. Scaling the given base rather than the constant is what
  // keeps the deck panel's 150 honest — that column zooms by the same factor as a page-width
  // wall does.
  //
  // **It used to move a floor and let the tiles stretch to fill the row**, which made the drawn
  // size a function of the column count and therefore a step function of the zoom: on the deck
  // panel's 331px column, seven of the ten stops the ladder had then drew exactly what the stop
  // before them drew. `TILE_BASE_WIDTH` carries the measurement.
  //
  // The other way to do this would be `transform: scale()` on the tiles, and it is wrong three
  // times over: it resamples the art, it leaves the column count at 1× so the wall no longer
  // reflows to the window, and it tells the virtualiser a row is a height it is not.
  const tileSize = scaled(baseTileWidth, cardZoom);

  /**
   * Each shelf with the tiles it has loaded and the count it is laid out at — `null` on a flat
   * wall, which is what keeps every wall that passes no `sections` exactly the wall it was.
   * `lib/shelfLayout.ts`' {@link loadedShelves} is the rule, and argues it.
   *
   * **Keyed on the list and the lookup, never on the `sections` object**, so a caller that builds
   * `{ sections, tilesOf, renderHeading, … }` inline re-lays nothing; see {@link GridSections}.
   */
  const sectionList = sections?.sections;
  const tilesOf = sections?.tilesOf;
  const shelfTiles = useMemo(
    () => (sectionList && tilesOf ? loadedShelves(sectionList, tilesOf) : null),
    [sectionList, tilesOf],
  );

  /**
   * What the deepest shelf's rows are pushed in by, taken off the wall **before** the column count
   * is decided: `layoutShelves` takes one column count for every shelf, so it has to be one the
   * most-indented shelf can still draw. `0` on a flat wall, where `tileArea` is `width` exactly.
   */
  const indentReserve = useMemo(
    () =>
      sectionList
        ? sectionList.reduce((deepest, { shelf }) => Math.max(deepest, shelf.indent), 0) *
          SHELF_INDENT_PX
        : 0,
    [sectionList],
  );
  // `width > 0` keeps an unmeasured wall unmeasured: `tileWidthFor` reads 0 as "no answer yet" and
  // draws the base size, which a reserve subtracted from 0 would turn into a clamp to 1px.
  const tileArea = indentReserve > 0 && width > 0 ? Math.max(1, width - indentReserve) : width;

  const columns = columnsFor(tileArea, tileSize);
  const tileWidth = tileWidthFor(tileArea, tileSize);
  const gutter = sideGutterFor(tileArea, tileSize);

  // The chin is **attached** to the card rather than spaced under it, so there is no gap in this
  // budget any more — the tile is the art plus the chin less the rise, which is exactly what
  // `chinHeight` and `CHIN_RISE` say. It used to be a budget for the quick-add button in the
  // caption; that control is over the art now and costs the wall no height at all.
  const captionHeight = chinHeight(cardZoom) - CHIN_RISE;
  const tileHeight = Math.round(tileWidth * (7 / 5)) + captionHeight;

  /**
   * The shelves laid out at this column count: the rows, which loaded tile fills which slot, where
   * the loaded run ends, and every row's key.
   *
   * `slots` is indexed by a tile's slot in the layout's flat order — the number published as
   * `data-grid-index` here, see {@link GRID_INDEX_ATTR} — and a hole is a slot whose page has not
   * landed. `frontier` is the slot after the last loaded tile in shelf order; the paging effect
   * watches its row. `keys` is what the virtualiser keys rows by — see {@link shelfRowKey}.
   */
  const shelved = useMemo(() => {
    if (!shelfTiles) return null;
    const { layout, slots, frontier } = fillShelves(shelfTiles, columns);
    const keys = layout.rows.map((_, index) => shelfRowKey(layout, index));
    return { layout, slots, frontier, keys };
  }, [shelfTiles, columns]);

  const rowCount = shelved ? shelved.layout.rows.length : Math.ceil(rows.length / columns);

  /**
   * The box the rows are scrolled through — this wall's own, or under {@link grow} whatever
   * ancestor scrolls.
   *
   * State rather than a ref because the virtualiser has to *hear* about it: `getScrollElement`
   * is read on each render, so an answer that only ever changed inside a ref would leave the
   * first render's `null` in place and the wall would draw nothing until something else happened
   * to re-render it. The walk runs in a layout effect, so the element is known before the browser
   * paints the first frame.
   *
   * The fallback to this wall's own element is what keeps every existing test and story green —
   * see {@link nearestScroller} for why the walk can never succeed under jsdom.
   */
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!grow) {
      setScroller(wallRef.current);
      return;
    }
    setScroller(nearestScroller(wallRef.current) ?? wallRef.current);
  }, [grow]);

  /**
   * How far the first row sits below the top of {@link scroller}'s content — 0 for a wall that is
   * its own scroller, and the filter bar plus the status line plus `main`'s padding for one that
   * grows.
   *
   * The virtualiser positions rows from the scroller's origin, so without this every tile on a
   * growing wall is drawn that many pixels too high and `scrollToIndex` lands short by the same
   * amount. It is measured rather than summed from constants because everything above the wall
   * moves: the filter bar rewraps into four different arrangements by its own width, and the two
   * banners above the rows grow into place when a page fails.
   *
   * **Which is why it is remeasured from a `ResizeObserver` over every box between the wall and
   * the scroller, rather than once on mount or on every render.** A box moves down the page when
   * a box *above* it grows, and nothing observable happens to the box that moved — so watching
   * the wall alone would see none of it. Watching its ancestors does: whatever grows above the
   * wall is inside one of them, so its parent's height changes and that is a resize. The
   * scroller itself is in the set for the window resize that rewraps the bar in the first place.
   *
   * It writes only when the number actually moved — a resize of the wall's own box is the common
   * case (a page of rows arriving) and moves nothing — so a measurement is not a render.
   * `clientTop` is the scroller's top border, which `scrollTop` is measured from the inside of
   * and a bounding rect from the outside of.
   */
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const rowsEl = rowsRef.current;
    const wall = wallRef.current;
    if (!grow || !scroller || !rowsEl || !wall) return;
    const measure = () => {
      const next =
        rowsEl.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        scroller.clientTop +
        scroller.scrollTop;
      // Sub-pixel jitter is what a fractional layout answers on a zoomed display; a threshold
      // rather than an equality keeps that from being an endless pair of renders.
      setScrollMargin((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (let el: HTMLElement | null = wall; el && el !== scroller; el = el.parentElement) {
      observer.observe(el);
    }
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [grow, scroller]);

  /**
   * **How far below its scroller's top edge a `sticky top-0` element really pins** — the scroller's
   * own `padding-top`, which the sticky bar's anchor takes off again as a negative `top` so the bar
   * sits flush against the top of the scrollport, or against the foot of a docked bar `stickyTop`
   * below it.
   *
   * Chromium contracts a sticky element's constraint rectangle by the scroll container's padding,
   * so `top: 0` means "the padding edge", not "the top of what the reader sees". Measured
   * 2026-09-26 in headless Edge (WebView2's engine): a `top: 0` child of a `p-3` scroller pinned
   * **12px** down at every scroll offset, of a `p-5` one **20px** down — which on both shelved
   * pages (`grow`, so the scroller is `AppShell`'s `main`, `p-5`) is a bar floating 20px under the
   * top with tiles sliding past in the strip above it. With `top` at minus the padding, both pinned
   * at **0**, and moved with the content until they got there.
   *
   * Measured rather than written down, because the scroller is not this component's under `grow` —
   * `main`'s padding is `AppShell`'s to change. Re-read on the scroller's resizes for the one
   * change that could move it, a breakpoint. `0` in jsdom (no stylesheet), where the anchor then
   * keeps its plain `top-0`; sectioned walls only, so a flat wall reads nothing.
   */
  const sectioned = shelfTiles !== null;
  const [stickyInset, setStickyInset] = useState(0);
  useLayoutEffect(() => {
    if (!sectioned || !scroller) return;
    const read = () => {
      const next = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      setStickyInset((prev) => (prev === next ? prev : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [sectioned, scroller]);

  /**
   * The virtualiser's row keys on a sectioned wall — {@link shelfRowKey}, held still per layout.
   *
   * **This is the wall's structure key, and it does two jobs.** A row keyed by what it *is* keeps
   * its React identity when the rows above it change (see `shelfRowKey`). And `getItemKey` is one
   * of the virtualiser's measurement inputs (`getMeasurementOptions` in `@tanstack/virtual-core`),
   * so a new layout is re-measured **in the render that produced it** — where a `measure()` in an
   * effect, the route the zoom takes below, draws one frame at the old pitch first.
   *
   * `undefined` on a flat wall, which the virtualiser reads as its default index key — so those
   * walls are keyed exactly as they were.
   */
  const rowKey = useMemo(
    () => (shelved ? (index: number) => shelved.keys[index] ?? `row:${index}` : undefined),
    [shelved],
  );

  /**
   * **The heading being carried stays drawn** — spec §3.9, and live-pass FAIL 4 (2026-09-26).
   *
   * A folder drag folds the wall, and the fold's own render reads the scroll offset the unfolded
   * wall had — 5664 against a folded wall 1210 tall — so the virtualiser's window lands at the end
   * of the wall and the carried heading's row, somewhere near its top, is not in it. It unmounted
   * for that frame, and dnd-kit's feedback element went with it: nothing followed the pointer. So
   * the carried heading's row joins whatever window the virtualiser picks, from the press to the
   * next one, and its `heading:<id>` key keeps it the same element through the fold, the unfold and
   * a move. `null` on a flat wall, which never subscribes to anything that changes.
   */
  const carriedId = useSyncExternalStore(shelfCarry.subscribe, () =>
    sectioned ? shelfCarry.carried() : null,
  );
  const carriedIndex = useMemo(
    () =>
      shelved && carriedId !== null
        ? shelved.layout.rows.findIndex((row) => row.kind === "heading" && row.shelf.id === carriedId)
        : -1,
    [shelved, carriedId],
  );
  const rangeExtractor = useMemo(
    () =>
      carriedIndex < 0
        ? undefined
        : (range: Range) => {
            const drawn = defaultRangeExtractor(range);
            return drawn.includes(carriedIndex)
              ? drawn
              : [...drawn, carriedIndex].sort((a, b) => a - b);
          },
    [carriedIndex],
  );

  /**
   * **Temporary room above and below the wall**, which the fold anchor adds when the folded wall
   * is too short to put the carried heading under the pointer (`anchorPlan`) and the unfold takes
   * away. The virtualiser's own `paddingStart`/`paddingEnd`, so every row, the window it draws and
   * the total all move together. Always `0` on a flat wall.
   */
  const [room, setRoom] = useState({ start: 0, end: 0 });

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller,
    // A flat wall's rows are one pitch. A sectioned wall's are one of four: a tile row is the same
    // pitch as a flat one, and a heading, a label and an empty box are `shelfLayout.ts`'s
    // constants — **chrome, which the zoom does not scale** (spec §5.2), so a ctrl+wheel reflows
    // the tiles and leaves every heading its own height.
    estimateSize: shelved
      ? (index) => rowHeight(shelved.layout.rows[index], tileHeight + GAP)
      : () => tileHeight + GAP,
    getItemKey: rowKey,
    rangeExtractor,
    paddingStart: room.start,
    paddingEnd: room.end,
    // **The sticky bar's strip is not somewhere a row can be revealed to** — final review S-M2 and
    // the re-check's check H, where headings brought in from above landed half under the bar. On a
    // sectioned wall every `scrollToIndex` that aligns a row to the top (a reveal, an arrow walk, a
    // caret chasing its tile) stops the bar's height short of it — plus `stickyTop`, the docked bar
    // the shelf bar stacks under while the filter quick bar is down, since that strip is covered
    // too. `scrollToIndex` sets the offset itself and never reads CSS `scroll-padding`, so `main`'s
    // own padding cannot stand in for this. `0` on a flat wall, which has no bar and is the
    // virtualiser's own default. Read every render, so a bar dropping in mid-scroll takes effect on
    // the next scroll the wall asks for.
    scrollPaddingStart: shelved ? SHELF_STICKY_HEIGHT + stickyTop : 0,
    scrollMargin,
    // Two rows of tiles beyond the viewport, which is the prefetch: their `<img>`s mount
    // and the protocol fills the cache before the reader scrolls onto them.
    overscan: 2,
  });

  /**
   * **Where the fold anchor puts a shelf's heading** — a {@link ShelfAnchorRequest}, answered from
   * the layout rather than from the DOM (see `shelfCarry` for why a box cannot answer it).
   *
   * The row's top in the scroll content is `rowStartOf` plus where the wall's first row sits in
   * it: the measured `scrollMargin` under `grow`, the wall's own `p-3` on a bounded wall. The
   * target is the request's `clientY` less the scroller's top. `anchorPlan` answers the offset and
   * any room; room changes need a render before the offset can be reached, so the offset waits in
   * {@link pendingOffset} for the commit that draws the room. Held in a ref and refreshed every
   * commit, so a request answers against the layout on screen.
   */
  const pendingOffset = useRef<number | null>(null);
  /**
   * Every shelf's folder path this wall has laid out, so a request naming a shelf the *current*
   * layout does not draw can still find its nearest drawn ancestor — see the fallback below.
   */
  const knownPaths = useRef<Map<number, readonly number[]> | null>(null);
  useLayoutEffect(() => {
    if (!shelved) return;
    const paths = (knownPaths.current ??= new Map());
    for (const row of shelved.layout.rows) {
      if (row.kind !== "label") paths.set(row.shelf.id, row.shelf.pathIds);
    }
  }, [shelved]);
  const anchorShelf = useRef<(request: ShelfAnchorRequest) => void>(() => undefined);
  useLayoutEffect(() => {
    anchorShelf.current = (request) => {
      if (!shelved || !scroller) return;
      const headingAt = (id: number) =>
        shelved.layout.rows.findIndex((row) => row.kind === "heading" && row.shelf.id === id);
      let index = headingAt(request.shelfId);
      // **A shelf only the folded wall drew** — fix round 1, Important 2. The fold opens every
      // collapsed shelf before folding it (`foldedForDrag`), so a drop can land on the heading of a
      // child whose parent is collapsed on the real page; after the unfold that heading is not in
      // the layout. The nearest ancestor that is drawn stands in for it, then the carried heading,
      // so the page is still anchored where the reader let go.
      const path = knownPaths.current?.get(request.shelfId) ?? [];
      for (let at = path.length - 2; index < 0 && at >= 0; at--) index = headingAt(path[at]);
      const carried = shelfCarry.carried();
      if (index < 0 && carried !== null) index = headingAt(carried);
      if (index < 0) {
        // Nothing to anchor on, but the room the fold added still goes: on the real page it is
        // blank space above or below the wall. The rows keep their place on screen as it does.
        if (!request.room && (room.start !== 0 || room.end !== 0)) {
          pendingOffset.current = Math.max(0, scroller.scrollTop - room.start);
          setRoom({ start: 0, end: 0 });
        }
        return;
      }
      const box = scroller.getBoundingClientRect();
      const rowsTop = grow ? scrollMargin : WALL_INSET_PX;
      const plan = anchorPlan({
        rowTop: rowsTop + rowStartOf(shelved.layout, index, tileHeight + GAP),
        target: request.top - box.top - scroller.clientTop,
        viewport: scroller.clientHeight,
        // **The page without the room, which the page cannot tell us** once a stretched row has
        // swallowed some of it (see `anchorPlan`): taking the whole room off is too little and
        // leaving it on too much. So each request errs where its own scroll corrects it. One that
        // may add room takes it all off — at worst it adds room it did not need, and still lands.
        // One that may not leaves it on — its scroll runs after the room has gone, so the
        // browser's own end clamps it, where a figure that subtracted swallowed room stopped the
        // Escape from a short page hundreds of pixels early.
        content: scroller.scrollHeight - (request.room ? room.start + room.end : 0),
        // The wall's own end, which is where room below starts to count — see `anchorPlan` for
        // the row a taller dock stretches, where the page's end is not the wall's.
        end: rowsTop + layoutHeight(shelved.layout, tileHeight + GAP),
        room: request.room,
      });
      if (plan.padStart !== room.start || plan.padEnd !== room.end) {
        // **A state update reached from a layout effect, on purpose** (fix round 1, Minor 5) — this
        // runs inside `useFoldAnchor`'s layout effect. The room has to be *in the DOM* before the
        // offset it was added for is reachable (the browser clamps a scroll to the content it
        // has), so it commits first — synchronously, before paint, which is what an update
        // scheduled from a layout effect does — and the offset follows in the effect below. Not a
        // pattern to copy for derived state: this is a measurement that needs a commit between its
        // two halves.
        pendingOffset.current = plan.scrollTop;
        setRoom({ start: plan.padStart, end: plan.padEnd });
        return;
      }
      virtualizer.scrollToOffset(plan.scrollTop);
    };
  });
  useLayoutEffect(() => {
    if (!sectioned) return;
    return shelfCarry.attach((request) => anchorShelf.current(request));
  }, [sectioned]);
  useLayoutEffect(() => {
    const offset = pendingOffset.current;
    if (offset === null) return;
    pendingOffset.current = null;
    virtualizer.scrollToOffset(offset);
  }, [room, virtualizer]);

  /**
   * **A drop settles on the moved heading.** A folder move is written and then refetched, so the
   * new order reaches the wall after the unfold; when it does, and the carried heading's place in
   * the order has changed, it goes to the pointer (`shelfCarry.settling`). Once, and only while
   * the drop is settling — a page of cards landing does not move a heading's place, and a reader
   * who has scrolled, pressed a key or clicked has ended the settling.
   *
   * **This depends on the move not being optimistic** (fix round 1, Minor 6). The settling starts
   * in `shelfCarry.fold(false)`, in `useFoldAnchor`'s layout effect — *after* this effect in the
   * same commit — so an order that arrived in the unfold commit itself would be recorded here as
   * the starting place and never settled. Both pages' folder moves are write-then-refetch today;
   * one that became optimistic would need the settling to start before this effect runs.
   */
  const carriedPlace = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = shelfCarry.carried();
    const place = shelved && id !== null ? headingPlace(shelved.layout, id) : null;
    const moved = place !== carriedPlace.current;
    carriedPlace.current = place;
    if (!moved || place === null) return;
    const settle = shelfCarry.settling();
    if (settle === null) return;
    anchorShelf.current(settle);
    shelfCarry.interrupt();
  }, [shelved]);

  // Row heights are cached from the first `estimateSize` call, so a resize that changes
  // the column count — and with it every tile's height — has to say so, or the rows keep
  // the old pitch and overlap.
  //
  // **A zoom arrives through this same door and needs nothing of its own**: it moves the floor,
  // the floor moves the tile, and `tileHeight` is what a row's pitch is made of. Keyed on the
  // height rather than on the zoom deliberately — a zoom step that changed neither the column
  // count nor the chin left the pitch alone, and there is nothing to remeasure.
  useEffect(() => {
    virtualizer.measure();
  }, [tileHeight, virtualizer]);

  /**
   * **Every selection this wall makes — and on a wall the arrows move, the caret stays on the
   * tile.**
   *
   * `onSelect` writes `selectedCardId`, which mounts the card pane's body, and that body focuses
   * itself as it opens. That is right for a wall the reader is passing *through* and wrong for one
   * they are walking: announced for the arrows alone, the walk worked and **a click did not** —
   * pressing a tile put the caret in the pane, so the reader's first arrow moved nothing.
   *
   * **`arrowNav` is the test, and it is the honest one.** It is exactly "is this a wall the reader
   * navigates", so the two surfaces that pass nothing keep the pane's ordinary contract — and the
   * printings modal *needs* to: a press there is a swap or a look, the modal closes on it, and a
   * caret left on a tile of a wall that no longer exists is a caret on `<body>`.
   */
  /**
   * The picked set for this wall — issue #214.
   *
   * The hook is called unconditionally (it is a hook) with {@link NO_SELECTION} standing in for a
   * wall that opted out; nothing writes under that scope, because {@link select} below asks
   * `selectionScope` before it picks anything. So an opted-out wall reads an empty set forever and
   * behaves exactly as it did before this existed.
   *
   * The order is the rows as drawn, which is what a Shift range measures along. Memoised because
   * `useCardSelection` prunes against it on every render and because a fresh array would make its
   * callbacks new every time — and one of those callbacks ends up in a drag registration.
   */
  /**
   * The tiles this wall has loaded, in the order it draws them — `rows` itself on a flat wall (the
   * same array, so nothing downstream sees a new identity), and on a sectioned one every shelf's
   * loaded tiles in shelf order (spec §5.5). A collapsed shelf contributes nothing because nothing
   * of it was fetched, which is what keeps a Shift range from reaching into one.
   *
   * **Keys must be unique across shelves, and that is the caller's to make true** — the collection
   * puts the folder in its tile key for exactly this (`tileKeyOf(cardId, finish, folderId)`).
   */
  const drawn = useMemo(
    () => (shelfTiles ? shelfTiles.flatMap((s) => s.tiles) : rows),
    [shelfTiles, rows],
  );
  const selectionOrder = useMemo(() => drawn.map((card) => tileKey(card)), [drawn]);
  const picked = useCardSelection(selectionScope ?? NO_SELECTION, selectionOrder);

  const select = useCallback(
    (card: T, event?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
      // **The two halves of a press, and they are not the same string.** The set, the caret note
      // and the ring are about the *tile* — the collection draws a foil and a nonfoil of one
      // printing as two of them — while what opens is the *printing*. See {@link tileKey}.
      const key = tileKey(card);
      const cardId = card.id;
      // A tile with no printing selects nothing — see {@link GridCard.id}. The walk still steps
      // onto it, because a tile the arrows refuse to enter is a hole in the wall; what it does
      // not do is empty the pane on the way past, which is what `onSelect("")` would ask for.
      //
      // **The guard is on the card id and not on the key**, because a tile with a key of its own
      // still has nothing to open when the printing behind it has gone.
      if (!cardId) return;
      // A chord means the reader is building a set, not opening a card: the pane holds still and
      // nothing below this line runs. `pick` has already collapsed the set to this one tile when
      // it answers `false`, which is what keeps the ring and the pane agreeing.
      if (selectionScope !== undefined && event && picked.pick(key, event)) return;
      // **The note is stamped with the *card*, and it is the one thing here that is not the tile.**
      // Its reader was `CardDetailPane`'s mount effect, which asked `consumeCaretNote(cardId)`
      // with the card it was opening — so a note filed under `bolt:foil` is a note the surface
      // asking about `bolt` discards, and it then takes the caret anyway. That is the exact
      // failure this note exists to prevent, arriving on the one wall that will have keys *and*
      // `arrowNav`: the collection's. The note is about "is the caret already where this
      // selection belongs", the card surface is keyed on the printing, so the printing is what it
      // is stamped with.
      //
      // **It has had no reader since that pane was deleted on 2026-09-03, and needs none.**
      // `consumeCaretNote` has no caller outside the suite, so this write is a note nobody opens
      // — but the walk is *not* one press long again, which is how this comment first read.
      // `Dialog`'s panel-focus effect has `[]` deps, so it fires once when the modal opens rather
      // than per card, and the modal is `aria-modal` with `trapTab`: while a card is open this
      // wall is not reachable by keyboard at all, so its arrow handler never runs. See
      // `caretWalk.ts`, which carries the whole argument.
      if (arrowNav) keepCaretForCard(cardId);
      onSelect(cardId, card);
    },
    [arrowNav, onSelect, picked, selectionScope],
  );

  /**
   * What else a drag from one tile is carrying — the picked set less the tile itself, as payloads
   * (issue #214).
   *
   * **Held still across renders**, because it lands in every tile's drag-registration dependency
   * list: a fresh function per render would tear four hundred registrations down each time the
   * reader Ctrl-clicked, and a source that unregisters mid-gesture is a drop that never arrives.
   * The two live values it reads — the selection and the rows — come off refs for that reason.
   *
   * `dragsAll` is asked first and has a side effect by design: a tile picked up from *outside* the
   * set throws the set away, so a stray drag can never carry four cards the reader had forgotten
   * were picked.
   *
   * `undefined` on a wall that cannot be dragged from or has no scope, so nothing there registers
   * a preview callback and every existing wall behaves exactly as it did.
   */
  const dragRef = useRef({ picked, rows: drawn, dragPayload, dragRecord });
  useEffect(() => {
    dragRef.current = { picked, rows: drawn, dragPayload, dragRecord };
  }, [picked, drawn, dragPayload, dragRecord]);
  const draggableWall = selectionScope !== undefined && (dragPayload ?? dragRecord) !== undefined;
  const dragRest = useMemo(
    () =>
      draggableWall
        ? (card: T) => {
            const { picked: held, rows: drawn, ...seams } = dragRef.current;
            if (!held.dragsAll(tileKey(card))) return [];
            const wanted = new Set(held.keys);
            return drawn.flatMap((row) => {
              // The *tile*, on both sides: a wall whose foil and nonfoil of one printing are two
              // tiles must be able to drag one of them without the other coming along, and `id`
              // cannot tell them apart. See {@link tileKey}.
              if (tileKey(row) === tileKey(card) || !wanted.has(tileKey(row))) return [];
              // Whichever seam this wall uses. On a `dragRecord` wall the payload is read back
              // out of the composed record through the same fence a drop target reads it
              // through, so a tile carrying only a non-card mark — an any-printing wish —
              // contributes nothing rather than an invented payload.
              const payload =
                seams.dragPayload?.(row) ??
                (seams.dragRecord ? readDragData(seams.dragRecord(row) ?? {}) : null);
              return payload ? [payload] : [];
            });
          }
        : undefined,
    [draggableWall],
  );

  /**
   * The picked rows, in the order the wall draws them — what a menu built on a set acts on.
   *
   * `rows` order rather than pick order, because everything downstream of it is a *list of cards*
   * rather than a history of presses: `Add 4 cards to → Wishlist` writes four wishes, and the one
   * order a reader could check it against is the one on screen.
   *
   * Identity churn is free here in a way it is not for the drag: these two slots are read on
   * render rather than registered, so nothing is torn down when they change — `cardMenu`'s own doc
   * says so.
   */
  const pickedRows = useMemo(
    () => (picked.count > 1 ? drawn.filter((card) => picked.selected(tileKey(card))) : []),
    [drawn, picked],
  );
  const tileMenu = useCallback(
    (card: T) => cardMenu?.(card, picked.selected(tileKey(card)) ? pickedRows : []),
    [cardMenu, picked, pickedRows],
  );
  const tileMenuKey = useCallback(
    (card: T) => cardMenuKey?.(card, picked.selected(tileKey(card)) ? pickedRows : []),
    [cardMenuKey, picked, pickedRows],
  );

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length
    ? Math.min(rows.length - 1, (virtualRows[virtualRows.length - 1].index + 1) * columns - 1)
    : -1;
  /** The last row drawn, as a *row* — the sectioned wall's paging reads rows, not tiles. */
  const lastRenderedRow = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

  /**
   * **The stop this render draws** — the `data-grid-index` whose art is `tabIndex={0}` on an
   * {@link arrowNav} wall; `-1`, and unread, on a wall that keeps every tile a stop.
   *
   * {@link rovingKey} where that tile is drawn, and otherwise the first tile of the first row
   * actually on screen (the first drawn one if none is). **The fallback is the virtualiser's
   * doing**: the remembered tile scrolls out of the window and unmounts, and a wall whose only stop
   * is not in the DOM is a wall Tab walks straight past. On screen rather than merely drawn, so
   * Tabbing in does not scroll the page up to a tile in the overscan above the fold.
   *
   * An index rather than the key, so a list carrying one printing twice (two pages either side of a
   * sync, which the flat wall's slot keys exist for) still has exactly one stop.
   */
  let tabStopIndex = -1;
  if (arrowNav) {
    const onScreenFrom = virtualizer.range?.startIndex ?? 0;
    let firstDrawn = -1;
    let firstOnScreen = -1;
    scan: for (const v of virtualRows) {
      let from = v.index * columns;
      let to = Math.min(from + columns, rows.length);
      if (shelved) {
        const row = shelved.layout.rows[v.index];
        if (row?.kind !== "tiles") continue;
        ({ start: from, end: to } = row);
      }
      for (let at = from; at < to; at++) {
        const card = shelved ? shelved.slots[at] : rows[at];
        if (!card) continue;
        if (rovingKey !== null && tileKey(card) === rovingKey) {
          tabStopIndex = at;
          break scan;
        }
        if (firstDrawn < 0) firstDrawn = at;
        if (firstOnScreen < 0 && v.index >= onScreenFrom) firstOnScreen = at;
      }
    }
    if (tabStopIndex < 0) tabStopIndex = firstOnScreen >= 0 ? firstOnScreen : firstDrawn;
  }

  // A new list reuses this scroll container, and a browser clamps the old offset into
  // the new content rather than resetting it.
  //
  // A caret waiting on a tile goes with the old list. The index is a position in `rows`, and a
  // new search's row 40 is a different card — chasing it would scroll a reader who has just
  // retyped their query down to whatever landed there.
  //
  // The Tab stop goes with it for the same reason: a new list starts its stop at its top.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
    setPendingIndex(null);
    setRovingKey(null);
  }, [listKey, virtualizer]);

  useEffect(() => {
    // A sectioned wall pages by its own rule, below; `rows` is not what it draws.
    if (shelved) return;
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [shelved, lastRendered, rows.length, onNeedNextPage]);

  /**
   * **A sectioned wall asks for the next page once the slot after its last loaded tile is drawn** —
   * or, with nothing left unloaded, once its last tile is. Every shelf's size comes from its count,
   * so that slot's row is known before its page exists; a reader scrolling onto the empty frames is
   * a reader about to need them, and the virtualiser's two rows of overscan are the look-ahead the
   * flat wall's 80% rule buys.
   *
   * Re-run whenever `shelved` changes — which is every page that lands, since a page is a new
   * `tilesOf` — so a frontier still in the window after a page arrives asks again, as the flat
   * wall's does. The page's own `hasNextPage` / `isFetchingNextPage` gate stays the caller's.
   */
  useEffect(() => {
    if (!shelved) return;
    const { layout, frontier } = shelved;
    if (layout.totalTiles === 0) return;
    const frontierRow = rowOfTile(layout, Math.min(frontier, layout.totalTiles - 1));
    if (frontierRow >= 0 && lastRenderedRow >= frontierRow) onNeedNextPage();
  }, [shelved, lastRenderedRow, onNeedNextPage]);

  /**
   * **Bring the shelf a page names into view** — `GridSections.revealShelfId`, set when **Add
   * folder** opens a placeholder heading, so the name field being typed into is never below the
   * fold. Its heading row, or — for a headless shelf, an opened folder's own cards — its first row.
   *
   * `scrollToIndex` with the virtualiser's default `"auto"` alignment, which is `block: "nearest"`:
   * a row already on screen is not moved, one below the window lands flush with its bottom edge.
   * The virtualiser rather than `scrollIntoView`, because the row is very often not drawn yet.
   *
   * **Once per id**, remembered in a ref (a ref write, not a `setState`, so the effect rule is not
   * in play): the effect re-runs whenever `shelved` changes — every page that lands — and a reader
   * who scrolled away from a folder they are naming must not be dragged back to it by a refetch.
   * The ref is cleared when the page clears the id, so revealing the same shelf twice in a row
   * works. An id the layout does not hold does nothing and is not remembered, so a placeholder
   * whose row arrives a render after its id is still revealed when it does.
   */
  const revealShelfId = sections?.revealShelfId ?? null;
  const revealed = useRef<number | null>(null);
  useEffect(() => {
    if (revealShelfId === null) {
      revealed.current = null;
      return;
    }
    if (!shelved || revealed.current === revealShelfId) return;
    const layoutRows = shelved.layout.rows;
    let at = layoutRows.findIndex(
      (row) => row.kind === "heading" && row.shelf.id === revealShelfId,
    );
    if (at < 0) {
      at = layoutRows.findIndex((row) => row.kind !== "label" && row.shelf.id === revealShelfId);
    }
    if (at < 0) return;
    revealed.current = revealShelfId;
    // **A heading followed by its empty box brings the box too** — final review S-M5: Add folder
    // reveals the new folder's heading, a new folder is empty, and the dashed box the reader is
    // about to drop on sat below the fold. A heading above the window is aligned to the top (under
    // the bar); anywhere else the box's row is the one scrolled to, which is "nearest" — its end at
    // the window's bottom, with the heading just above it.
    const next = layoutRows[at + 1];
    const box = next?.kind === "empty" && next.shelf.id === revealShelfId ? at + 1 : at;
    const [, align] = virtualizer.getOffsetForIndex(at, "auto") ?? [0, "auto"];
    virtualizer.scrollToIndex(align === "start" ? at : box);
  }, [revealShelfId, shelved, virtualizer]);

  /**
   * The second half of an arrow press: put the caret on the tile the handler asked for, once
   * that tile is on screen.
   *
   * **`virtualRows` is a dependency and is the point of the whole arrangement.** A long jump —
   * Down through a wall the reader is only two rows into — lands on an index the virtualiser has
   * not drawn, so there is nothing to focus on the render the keypress caused. Re-running as the
   * window of drawn rows changes is what lets the caret arrive one render later instead of being
   * lost; `getVirtualItems()` is memoised on the range, so this does not fire on every render.
   *
   * **The scroll is retried here rather than trusted from the handler**, and that is the reflow
   * defence. `onSelect` opens the 384px detail pane, `columnsFor` divides what is left, and the
   * wall comes back with fewer columns — so the *row* the handler scrolled to is no longer the
   * row the wanted tile is in. The tile's absolute index is unchanged, so the lookup is still
   * right and the row is simply recomputed from whatever `columns` is now.
   *
   * `preventScroll`, then `scrollIntoView({ block: "nearest" })`: the virtualiser owns the
   * vertical offset and has already moved it, so a browser's own focus scroll is a second party
   * with an opinion about the same number. Doing it explicitly afterwards is idempotent — a tile
   * that is already fully visible is not moved — and covers the one thing `scrollToIndex` cannot,
   * which is a tile clipped by the wall's own 12px padding. `scrollIntoView` is one of the layout
   * APIs jsdom leaves undefined, hence the optional call.
   */
  useEffect(() => {
    if (pendingIndex === null) return;
    if (pendingIndex >= (shelved ? shelved.layout.totalTiles : rows.length)) {
      setPendingIndex(null);
      return;
    }
    // A wall that has drawn no rows at all — measured at zero height, or between lists — has
    // nothing to focus and nothing to scroll onto. Read here rather than only named in the
    // dependency array, because a dependency that the body never looks at is one a later reader
    // deletes as noise, and this effect's whole timing rests on it.
    if (virtualRows.length === 0) return;
    const tile = wallRef.current?.querySelector<HTMLElement>(
      `[${GRID_INDEX_ATTR}="${pendingIndex}"]`,
    );
    if (!tile) {
      // A sectioned wall's row is the layout's to say — a short row upstream moves every row below.
      virtualizer.scrollToIndex(
        shelved ? rowOfTile(shelved.layout, pendingIndex) : Math.floor(pendingIndex / columns),
      );
      return;
    }
    const caret = tile.querySelector<HTMLElement>(CARET_SELECTOR) ?? tile;
    caret.focus({ preventScroll: true });
    // **The tile is what is scrolled, and the button inside it is what takes the caret.** They
    // are not the same box and scrolling the wrong one is measurable: the button is the art
    // alone, so bringing *it* into view leaves the chin under it hanging past the
    // scrollport, and the scroll margin that makes room for the focus ring is on the tile and
    // does not reach a descendant. Measured 2026-08-18 in the shipped window arrowing down a
    // 117k-card browse: the tile's foot sat **2px** past the scroller's padding box every step,
    // where scrolling the tile lands it the intended **6px** clear.
    tile.scrollIntoView?.({ block: "nearest" });
    setPendingIndex(null);
  }, [pendingIndex, virtualRows, columns, rows.length, virtualizer, shelved]);

  /**
   * **The tile holding the caret, by its tile key** — and whether the caret is on its art (the
   * button every press lands on) or on the tile itself (where a closed menu hands it back).
   *
   * Live-pass FAIL 6 (2026-09-26) is why this exists. One Ctrl+wheel step that changed the column
   * count re-keyed the rows — a shelf's rows are keyed by their offset in it, and at five across
   * the row that started at slot 4 is gone — so the focused tile's element unmounted and the caret
   * fell to `<body>`, on both pages. **No key can prevent that**: a tile is the child of its row,
   * and a tile that changes row is a new element. The flat wall has the same fault in a quieter
   * form, since its rows and slots are keyed by position: the element survives and is simply
   * handed another card, so the caret sits on a card the reader never chose. So the caret is
   * remembered as *which tile*, and put back on it — see the effect below.
   *
   * Written by the wall's own focus events, never during render: a caret that moves to anything
   * that is not a tile's art or the tile itself — a popup in a tile, a heading's button, anything
   * outside the wall — is not this wall's to keep.
   */
  const caretTile = useRef<{ key: string; onArt: boolean } | null>(null);
  /** The card drawn at a `data-grid-index`, in the layout this wall last committed. */
  const cardAtIndex = useCallback(
    (index: number): T | undefined =>
      Number.isInteger(index) ? (shelved ? shelved.slots[index] : rows[index]) : undefined,
    [shelved, rows],
  );
  const cardAtRef = useRef(cardAtIndex);
  const onWallFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    // React types a focus event's `target` as the listening element; it is whatever took focus.
    const target: Element = e.target;
    const tileEl = target.closest<HTMLElement>(TILE_SELECTOR);
    const inTile = tileEl !== null && e.currentTarget.contains(tileEl);
    const card = inTile
      ? cardAtRef.current(Number(tileEl.getAttribute(GRID_INDEX_ATTR)))
      : undefined;
    // **Anywhere in a tile moves the Tab stop there** — a stepper or a quick-add popup included,
    // unlike the caret below: the reader is in that tile, so Shift+Tab out and Tab back in should
    // return to it, and its own controls (held out of the Tab order while it was not the stop)
    // are put back for the Tab that walks into them.
    if (arrowNav && card) setRovingKey(tileKey(card));
    const art = tileEl?.querySelector(CARET_SELECTOR) ?? null;
    if (!inTile || (target !== tileEl && target !== art)) {
      caretTile.current = null;
      return;
    }
    caretTile.current = card ? { key: tileKey(card), onArt: target === art } : null;
  };
  const onWallBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    // A caret the reader took elsewhere is theirs. `relatedTarget` is `null` when focus goes to
    // nothing at all — which is also what an unmounted element leaves behind — so only a caret
    // that landed *somewhere outside* forgets the tile.
    if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) {
      caretTile.current = null;
    }
  };

  /**
   * **Put the caret back on its tile after a re-layout** — the other half of {@link caretTile}.
   *
   * After every commit that changed the layout (the column count, the shelves, or the rows), if the
   * caret was on a tile of this wall and is now on `<body>` or on a *different* tile, it is put
   * back on the same tile — its art or itself, as it was — wherever the new layout draws it. A
   * layout effect, so the reader never sees a frame without it.
   *
   * **Only a re-layout moves a caret back.** A reader who scrolls the focused tile out of the
   * virtualiser's window loses the caret to `<body>` exactly as before — the wall does not scroll
   * them back to it. And only a **column change** may scroll to a tile the new layout did not
   * draw: the tile has not left the wall, only its row moved, so bringing the row on screen is
   * the one way to keep the caret the reader had. A tile that has left the wall is forgotten.
   */
  const laidOut = useRef({ columns, shelved, rows });
  /**
   * **The caret on its way to a tile the new layout has not drawn yet** — final review S-I2, and
   * the re-check's check C. A column change moves a deep tile's row off the drawn window; the wall
   * scrolls to it, and the tile is drawn only when that scroll's event arrives. Commits come first
   * — the zoom's own `measure()` is one — and the retry this replaced was a single one, spent on
   * the first of them; the scroll's commit then read as "not a re-layout" and forgot the tile, so
   * the page scrolled to it and the caret was on `<body>` (collection tile 63, wishlist tile 60).
   *
   * So the chase is remembered and asked again **every commit**, until the tile is drawn (the caret
   * goes onto it), the reader puts the caret somewhere else, a new re-layout starts over, or
   * {@link CARET_CHASE_COMMITS} commits pass. It is exempt from the "not a re-layout, so forget"
   * rule below, which is exactly the commit it exists to survive.
   */
  const caretChase = useRef<{ key: string; onArt: boolean; left: number } | null>(null);
  useLayoutEffect(() => {
    cardAtRef.current = cardAtIndex;
    const was = laidOut.current;
    const relaid = was.columns !== columns || was.shelved !== shelved || was.rows !== rows;
    const columnsMoved = was.columns !== columns;
    laidOut.current = { columns, shelved, rows };
    const wall = wallRef.current;
    if (!wall) return;
    const active = document.activeElement;
    const caretFree = active === null || active === document.body;
    const activeTile =
      active instanceof Element && wall.contains(active) ? active.closest(TILE_SELECTOR) : null;
    const keyAt = (at: number) => {
      const card = cardAtIndex(at);
      return card ? tileKey(card) : null;
    };
    const order = shelved ? shelved.slots : rows;
    const indexOf = (key: string) =>
      order.findIndex((card) => card !== undefined && tileKey(card) === key);
    const rowOfIndex = (at: number) =>
      shelved ? rowOfTile(shelved.layout, at) : Math.floor(at / columns);
    const tileAt = (at: number) =>
      wall.querySelector<HTMLElement>(`[${GRID_INDEX_ATTR}="${at}"]`);
    const caretInto = (tile: HTMLElement, onArt: boolean) =>
      (onArt ? (tile.querySelector<HTMLElement>(CARET_SELECTOR) ?? tile) : tile).focus({
        preventScroll: true,
      });
    /**
     * **A column change keeps the focused tile in view** — re-check new finding 6: a tile whose row
     * stayed drawn kept the caret and ended at −491…−175, above the window. `"auto"` alignment is
     * the virtualiser's "nearest": a row already in view does not move.
     */
    const keepInView = (at: number) => {
      if (columnsMoved) virtualizer.scrollToIndex(rowOfIndex(at));
    };

    const chase = caretChase.current;
    if (chase !== null && !relaid) {
      const at = indexOf(chase.key);
      const tile = at < 0 ? null : tileAt(at);
      if (!caretFree || at < 0) {
        // The reader has the caret somewhere else now, or the tile has left the wall.
        caretChase.current = null;
      } else if (tile) {
        caretChase.current = null;
        caretInto(tile, chase.onArt);
        return;
      } else if (--chase.left <= 0) {
        caretChase.current = null;
        caretTile.current = null;
        return;
      } else {
        return;
      }
    }
    if (relaid) caretChase.current = null;

    const want = caretTile.current;
    if (!want) return;
    const onWanted =
      activeTile !== null && keyAt(Number(activeTile.getAttribute(GRID_INDEX_ATTR))) === want.key;
    if (!relaid) {
      // **Not a re-layout, so whatever happened to the caret was the reader's** — fix round 1,
      // Important 1. Scrolling a focused tile out of the window unmounts it and drops the caret on
      // `<body>` with no focus event to say so; remembered, that tile would be scrolled back to and
      // focused by the next column change (a Ctrl+wheel, a window resize, a docked panel's drag),
      // minutes later. So a caret that is no longer on its tile here is forgotten.
      if (!onWanted) caretTile.current = null;
      return;
    }
    if (!caretFree && activeTile === null) return;
    if (onWanted) {
      keepInView(Number(activeTile.getAttribute(GRID_INDEX_ATTR)));
      return;
    }
    const index = indexOf(want.key);
    if (index < 0) {
      caretTile.current = null;
      return;
    }
    const tile = tileAt(index);
    if (tile) {
      caretInto(tile, want.onArt);
      keepInView(index);
      return;
    }
    if (!columnsMoved) {
      caretTile.current = null;
      return;
    }
    // Not drawn: bring its row on screen, and chase the caret there — see `caretChase`.
    caretChase.current = { key: want.key, onArt: want.onArt, left: CARET_CHASE_COMMITS };
    virtualizer.scrollToIndex(rowOfIndex(index));
  });

  /**
   * One arrow press: move the selection, and take the caret with it.
   *
   * **One handler on the scroller rather than one per tile**, which is the same economy every
   * other callback on this component is written for — an unfiltered browse is ~117 k rows, and a
   * fresh closure per tile is what `dragPayload` and `gameChanger` each carry a paragraph asking
   * callers not to do. Keydown bubbles, so a press on the art button, on a corner mark, on the
   * action strip or on the chin all arrive here with a `target` inside the tile it happened in.
   *
   * The bail-outs, in the order they are cheapest:
   *
   * - **Not armed.** Three of this component's four callers pass nothing; see `arrowNav`.
   * - **Already handled.** A tile's own `cardMenuKey` and any layer above this one run first, and
   *   `defaultPrevented` is this app's handshake for "that press was mine" — the same protocol
   *   `useDismissOnEscape` runs on.
   * - **A modifier is down.** Ctrl+arrow, Alt+arrow and their friends belong to the browser, to
   *   the window manager, or to a gesture this wall already has (ctrl+wheel zooms it). Shift is
   *   in the list because Shift+arrow is a *selection* gesture everywhere else it exists, and
   *   this wall has no range selection to extend — swallowing it would promise one.
   * - **The caret is in a field.** See {@link FIELD_SELECTOR}.
   * - **The caret is on the wall but not on a tile.** Nothing to move from.
   * - **The caret is inside a tile but not on it** — the quick-add's popup, drawn in the tile's
   *   own action strip. See the check itself for the two positions that do count.
   *
   * `columns` is read at press time and is therefore the count the reader was *looking at*, which
   * is the only honest answer: the pane the press is about to open re-flows the wall underneath
   * it, so a move computed against the post-reflow count would be a move down a grid nobody had
   * seen yet. The effect above is where that reflow is dealt with.
   */
  const onArrowKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!arrowNav || e.defaultPrevented) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(FIELD_SELECTOR)) return;
    const from = target.closest<HTMLElement>(TILE_SELECTOR);
    if (!from) return;
    // **Inside a tile is not enough: the caret has to be on the tile.** The quick-add's popup is
    // `role="dialog"` drawn *in the tile's action strip* — `SearchPage` passes it `static` so a
    // 256px panel on a 170px tile opens from the tile's own left edge — so a reader stepping through
    // its finish chips and condition rows is holding a caret that `closest` reports as being on
    // a card. Walking the wall out from under them would be taking a key the control they opened
    // is using, and the field test above cannot see it because those chips are buttons.
    //
    // Two positions count, and they are the two places this wall ever puts a caret: the art
    // button, which is where a walk starts and where each step lands; and the tile's root, which
    // is what `ContextMenu` focuses back when a tile's menu closes, so the walk survives a
    // right-click.
    const caret = from.querySelector<HTMLElement>(CARET_SELECTOR);
    if (target !== from && !caret?.contains(target)) return;

    const at = Number(from.dataset.gridIndex);
    if (shelved) {
      // **The shelves' own table** (spec §5.4, `nextShelfTileIndex`): Left/Right walk the
      // depth-first order across shelf boundaries, Up/Down move within a shelf and past its edge to
      // the nearest column of the next or previous shelf's row, skipping headings. Every other key
      // is not this wall's, exactly as `nextGridIndex` answers it.
      if (!isShelfArrow(e.key) || !Number.isInteger(at)) return;
      const next = nextShelfTileIndex(shelved.layout, at, e.key);
      if (next === null) return;
      e.preventDefault();
      const card = shelved.slots[next];
      // `select` for the caret note, as below. A slot whose page has not landed selects nothing —
      // there is no card to open — but the wall still scrolls to it, which draws its row, which is
      // what asks for the page; the next press then has a card to land on.
      if (card) select(card, e);
      virtualizer.scrollToIndex(rowOfTile(shelved.layout, next));
      if (card) {
        setPendingIndex(next);
        setRovingKey(tileKey(card));
      }
      return;
    }
    const next = nextGridIndex(at, e.key, columns, rows.length);
    if (next === null) return;

    e.preventDefault();
    // `select` rather than `onSelect`: the caret note lives in there, so a *press* on a tile gets
    // it too and the reader's first arrow after clicking has somewhere to move from.
    //
    // **The event travels, so Shift+Arrow extends the picked set** (issue #214) exactly as
    // Shift+click does, and a plain arrow collapses it onto the tile the walk landed on — which
    // is what keeps the ring and the pane agreeing all the way along the walk. On a wall with no
    // `selectionScope` the chords reach nothing and the press is the walk it always was.
    select(rows[next], e);
    // Scroll first, focus later. The tile may not be drawn yet — see `pendingIndex` — and the
    // virtualiser is the only thing that can put it on screen, since it owns this scroller's
    // offset outright.
    virtualizer.scrollToIndex(Math.floor(next / columns));
    setPendingIndex(next);
    // The stop moves with the walk in the same render, rather than waiting for the focus the
    // effect above delivers — which may be a render or two behind a tile still being drawn.
    setRovingKey(tileKey(rows[next]));
  };

  /**
   * Back to the top of the wall — the sticky bar's **Top** (spec §5.3). Held still because it is
   * handed to the caller's `renderSticky` on every render.
   */
  const stickyRef = useRef<HTMLDivElement>(null);
  /**
   * **Top was pressed from inside the bar** — final review S-I1. At the top of the wall the bar
   * names nothing and is not drawn (`stickyShelfAt`), so the Top that took the page there is
   * unmounted by its own scroll and a keyboard caret on it fell to `<body>`. The intent is kept
   * here and carried out by the layout effect below, on the commit that sees the bar gone.
   */
  const topCaret = useRef(false);
  const scrollToTop = useCallback(() => {
    const anchor = stickyRef.current;
    topCaret.current = anchor !== null && anchor.contains(document.activeElement);
    virtualizer.scrollToOffset(0);
  }, [virtualizer]);
  /**
   * The other half of {@link topCaret}: once the caret is no longer in the bar — the scroll has
   * landed and the bar has gone — it goes to the wall's first control, the first drawn row's (rows
   * are drawn in order). A caret the reader has put anywhere else in the meantime is theirs, and a
   * bar still drawn at the top keeps its Top and the caret on it.
   */
  useLayoutEffect(() => {
    if (!topCaret.current) return;
    const anchor = stickyRef.current;
    const active = document.activeElement;
    if (anchor !== null && active !== null && anchor.contains(active)) return;
    topCaret.current = false;
    if (active !== null && active !== document.body) return;
    wallRef.current
      ?.querySelector<HTMLElement>(`[data-shelf-row] :is(${FIRST_CONTROL})`)
      ?.focus({ preventScroll: true });
  });

  /**
   * The shelf the sticky bar names — see {@link stickyShelfAt}. The edge is where the bar's top
   * sits in the virtualiser's coordinates: the scroller's offset, less the wall's own `p-3` on a
   * bounded wall, and exactly the offset under `grow`, where `scrollMargin` is already inside every
   * row's `start`. Both assume the bar is pinned flush with the top of the scrollport, or with the
   * foot of a docked bar `stickyTop` below it, which the anchor's `stickyInset` correction is what
   * makes true — so `stickyTop` is added here too, and the bar names the shelf under its own top
   * edge rather than the one the docked bar is covering.
   *
   * **As fresh as the last render, and no fresher**: the virtualiser re-renders when its range or
   * its is-scrolling flag changes, not per pixel, so inside one row the bar can trail by that row
   * and settles when the scroll ends. The live pass is where this is judged (spec §8).
   */
  const stickyShelf = shelved
    ? stickyShelfAt(
        shelved.layout,
        virtualRows,
        (virtualizer.scrollOffset ?? 0) - (grow ? 0 : WALL_INSET_PX) + stickyTop,
      )
    : null;

  /**
   * The gap the virtualiser counts after the last row, which the sizer leaves off — a tile row's
   * `GAP` on the flat wall, as it always was. A sectioned wall can end on a heading or an empty
   * box, whose constants carry gaps of their own sizes, so only a trailing tile row's is removed.
   */
  const lastLayoutRow = shelved
    ? shelved.layout.rows[shelved.layout.rows.length - 1]
    : undefined;
  const trailingGap = shelved ? (lastLayoutRow?.kind === "tiles" ? GAP : 0) : GAP;

  /** One tile, as both kinds of wall draw it — one list of the tile's slots, not two. */
  const renderTile = (card: T, gridIndex: number, key: string) => (
    <Tile
      key={key}
      card={card}
      // Where this tile sits in the whole list — not in the row it is drawn in. See
      // `GRID_INDEX_ATTR` for why the absolute number is the one that survives the reflow an arrow
      // press causes, and what the number is on a sectioned wall.
      gridIndex={gridIndex}
      // Every tile on a wall with no arrows; one on a wall with them — see `tabStopIndex`.
      tabStop={!arrowNav || gridIndex === tabStopIndex}
      width={tileWidth}
      zoom={cardZoom}
      onSelect={select}
      // **The pane's card, or a member of the picked set** — one gold ring for both, which is issue
      // #214's answer rather than an economy: gold already means *picked* on this wall, and a
      // reader who has Ctrl-clicked four tiles has picked four. The pane shows the last one they
      // opened, as a pane always has.
      //
      // **The pane's half compares the ring key, the set's half the tile key** — see
      // `GridCard.ringKey`: one printing on two shelves is two tiles and one open card, and both
      // ring; a Ctrl-click still picks the one tile. Without a `ringKey` both halves are the tile
      // key, which is what stops a wall that draws a foil and a nonfoil of one printing from
      // ringing both when the reader pressed one — see {@link tileKey}.
      selected={
        (card.ringKey ?? tileKey(card)) === selectedId || picked.selected(tileKey(card))
      }
      dragRest={dragRest}
      badge={badge}
      badgeChrome={badgeChrome}
      topLeft={topLeft}
      topLeftPlacement={topLeftPlacement}
      bottomRight={bottomRight}
      finish={finish}
      treatment={treatment}
      gameChanger={gameChanger}
      action={action}
      column={column}
      caption={caption}
      money={money}
      cardMenu={tileMenu}
      cardMenuKey={tileMenuKey}
      tileRef={tileRef}
      dragPayload={dragPayload}
      dragRecord={dragRecord}
    />
  );

  return (
    <div
      ref={wallRef}
      role="group"
      aria-label={label}
      // No `tabIndex`: every tile is a button, so the wall is reachable and
      // scrollable from the keyboard through its own contents — one of them, on a wall that
      // takes the arrows (`arrowNav`). A tab stop on the box around them would be one more press
      // between the reader and the cards.
      //
      // Which is also why the arrow keys are listened for **here** rather than on the tiles: this
      // box holds no caret of its own, it holds every tile, and one listener is one closure
      // instead of 117 k. The handler bails on a wall that was not given `arrowNav`.
      onKeyDown={onArrowKey}
      onFocus={onWallFocus}
      onBlur={onWallBlur}
      className={cn(
        // `p-3` is both shapes' and is not decoration: `overflow` clips at the padding box, so on
        // a bounded wall it is the room a tile's focus ring and drop mark are drawn in
        // (`DROP_MARK_ROOM`'s rule, and `scroll-m-1.5` on the tile is the same 6px as a scroll
        // margin). A growing wall clips nothing, but the marks on its outermost tiles would
        // otherwise sit flush against the surrounding content.
        "p-3",
        grow
          ? // **`shrink-0`, because the box above is very often still a bounded flex column.** A
            // flex item defaults to `shrink: 1`, so a wall taller than the room its parent has
            // would be squashed to fit and its rows — absolutely positioned inside a sizer of the
            // full height — would spill out of a box that says it is shorter. The wall states its
            // own height and lets the overflow reach whatever scrolls.
            //
            // No frame here: see {@link grow}.
            "shrink-0"
          : "min-h-0 flex-1 overflow-auto rounded-md border border-border",
      )}
    >
      {shelved && sections && (
        // **The sticky bar** (spec §5.3). CSS `sticky` cannot work on the rows — they are
        // `absolute` and `translateY`'d — but it works on a normal-flow child of the scroller, and
        // a zero-height one moves nothing: the sizer below starts exactly where it did. The bar is
        // then `absolute` inside that anchor, over the rows, on `LAYER.header` so tile rows (even
        // one raised for an open popup, `LAYER.raised`) scroll under it. One arrangement for both
        // shapes: on a bounded wall `sticky` resolves against the wall, under `grow` against
        // `main`, which an `absolute` overlay could never reach. The anchor is always mounted on a
        // sectioned wall, so a drop target the caller draws in it (spec §6) is permanent.
        //
        // **`top-0` is corrected by the scroller's own padding** — see `stickyInset`: Chromium pins
        // a sticky box at the scroller's padding edge, so without the negative `top` the bar would
        // float 12px (bounded) or 20px (`main`, under `grow`) below the top of the scrollport. Flush
        // with the top of the scrollport, or with the foot of a docked bar `stickyTop` below it, is
        // also what the edge `stickyShelf` measures from assumes — so the `top` is
        // `stickyTop − stickyInset`, and the edge carries the same `stickyTop`.
        <div
          ref={stickyRef}
          data-shelf-sticky=""
          className={cn("sticky top-0 h-0", LAYER.header)}
          style={stickyInset || stickyTop ? { top: stickyTop - stickyInset } : undefined}
        >
          <div className="absolute inset-x-0 top-0">
            {sections.renderSticky(stickyShelf, scrollToTop)}
          </div>
        </div>
      )}
      {/* Holds the scrollbar open to the full height of the wall while the rows inside it
          are positioned absolutely — and, having no padding of its own, is the honest
          answer to how wide a row of tiles may be. The virtualiser's total counts a gap
          after the last row, which here would be padding under the wall that nothing is
          separating. */}
      <div
        ref={rowsRef}
        style={{
          height: Math.max(0, virtualizer.getTotalSize() - trailingGap),
          position: "relative",
        }}
      >
        {shelved && sections
          ? virtualRows.map((v) => {
              const row = shelved.layout.rows[v.index];
              if (!row) return null;
              // A label belongs to no shelf and stands at the wall's own edge.
              const indent = row.kind === "label" ? 0 : row.shelf.indent;
              const place = {
                // `- scrollMargin` for the flat rows' reason, below.
                transform: `translateY(${v.start - scrollMargin}px)`,
                // The gutter on every row, as on the flat wall, plus 32px a level — so a nested
                // shelf's heading, its tiles and its empty box all start at one left edge.
                paddingLeft: gutter + indent * SHELF_INDENT_PX,
                paddingRight: gutter,
              };
              const rails = <ShelfRails indent={indent} from={gutter} height={v.size} />;
              if (row.kind === "tiles") {
                return (
                  <div
                    key={v.key}
                    data-shelf-row="tiles"
                    {...{ [SHELF_ID_ATTR]: row.shelf.id }}
                    // Raised when a popup is open in it, exactly as a flat row is — see below.
                    className={cn(
                      "absolute inset-x-0 top-0 flex gap-3",
                      LAYER.raisedWhenPopupOpen,
                    )}
                    style={{ height: tileHeight, ...place }}
                  >
                    {rails}
                    {Array.from({ length: row.end - row.start }, (_, i) => {
                      const slot = row.start + i;
                      const card = shelved.slots[slot];
                      // Keyed by place in the row, as the flat wall keys by slot: a card that
                      // lands in a frame replaces it, and nothing else in the row remounts.
                      return card ? (
                        renderTile(card, slot, `slot-${i}`)
                      ) : (
                        <PendingSlot key={`slot-${i}`} slot={slot} width={tileWidth} />
                      );
                    })}
                  </div>
                );
              }
              // **Not `LAYER.raisedWhenPopupOpen`**: a heading's collapse chevron is
              // `aria-expanded="true"` whenever its shelf is open, so that variant would lift every
              // open heading to the raised layer — and a tile row's quick-add, opening down into
              // the heading below it, would then lose to the heading on document order.
              //
              // As tall as the row's whole pitch (`v.size`, its gap included): the caller's heading
              // sits at the top of it, and the rails reach the next row's top.
              return (
                <div
                  key={v.key}
                  data-shelf-row={row.kind}
                  {...(row.kind === "label" ? {} : { [SHELF_ID_ATTR]: row.shelf.id })}
                  className="absolute inset-x-0 top-0"
                  style={{ height: v.size, ...place }}
                >
                  {rails}
                  {row.kind === "heading"
                    ? sections.renderHeading(row.shelf)
                    : row.kind === "empty"
                      ? sections.renderEmpty(row.shelf)
                      : sections.renderLabel(row.group)}
                </div>
              );
            })
          : virtualRows.map((v) => (
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
                  // **`- scrollMargin`, because a virtual item's `start` is measured from the
                  // scroller's origin and this row is positioned from the sizer's.** The two are the
                  // same box only when the wall *is* the scroller, which is why this read `v.start`
                  // for as long as it was. Under `grow` they differ by everything above the wall —
                  // measured live at 165px on the search page (`main`'s padding, the filter bar and
                  // the status line), which is exactly how far down the page the first row was drawn
                  // before this subtraction existed. `getTotalSize` already takes it off, so the
                  // sizer was the right height and only the rows inside it were displaced: a wall
                  // that looks correct until you compare its first tile with its own top edge.
                  transform: `translateY(${v.start - scrollMargin}px)`,
                  paddingLeft: gutter,
                  paddingRight: gutter,
                }}
              >
                {rows
                  .slice(v.index * columns, v.index * columns + columns)
                  .map((card, i) =>
                    // Keyed by slot rather than by card id: two pages fetched either side of a
                    // sync can carry one printing twice, and a duplicate key drops a card.
                    renderTile(card, v.index * columns + i, `${v.index}-${i}`),
                  )}
              </div>
            ))}
      </div>
    </div>
  );
}

/**
 * One card, as art.
 *
 * The chrome is a `CardChin` and a focus ring, plus whatever the caller hangs in the two corners
 * and in the action strip over the picture's foot. The rarity is the chin's 6px gem — the only
 * colour in the tile that is not the card's own, and a filled badge there would out-shout what it
 * annotates.
 */
function Tile<T extends GridCard>({
  card,
  gridIndex,
  tabStop,
  width,
  zoom,
  onSelect,
  selected,
  badge,
  badgeChrome = "chip",
  topLeft,
  topLeftPlacement = "nameplate",
  bottomRight,
  finish,
  treatment,
  gameChanger,
  action,
  column,
  caption,
  money,
  cardMenu,
  cardMenuKey,
  tileRef,
  dragPayload,
  dragRecord,
  dragRest,
}: {
  card: T;
  /**
   * Where this tile sits in the whole list, published as `data-grid-index` on its root.
   *
   * Unconditional, and never a function of whether the wall takes the arrow keys — see
   * {@link GRID_INDEX_ATTR}, which is where the reasoning for the attribute lives.
   */
  gridIndex: number;
  /**
   * **Whether Tab stops on this tile at all** — `false` on every tile of an `arrowNav` wall but
   * its one stop (issue #558; `tabStopIndex` in {@link CardGrid}).
   *
   * **The whole tile leaves the Tab order, not only its art**: the controls a caller hangs in its
   * slots — the search's quick-add, the collection's stepper (two buttons and a field), the
   * wishlist's pencil and stepper — are Tab stops of their own, and a wall that roved only the art
   * would still cost up to four presses a tile. None of them is lost to a keyboard: the arrows
   * make a tile the stop, and Tab from its art walks into its own controls, which is what a
   * roving *tile* means. A pointer is untouched — a `-1` control still takes a click and the
   * focus that comes with it, and that focus makes its tile the stop.
   */
  tabStop: boolean;
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
  /**
   * The press, with the **whole row** rather than an id.
   *
   * The wall's `select` needs both halves of a tile — the printing it opens and the tile it rings,
   * picks and files a caret note under — and only the row carries both. See {@link tileKey}.
   */
  onSelect: (card: T, event: ReactMouseEvent) => void;
  selected: boolean;
  badge?: (card: T) => ReactNode;
  badgeChrome?: "chip" | "bare";
  topLeft?: (card: T) => ReactNode;
  topLeftPlacement?: "nameplate" | "clear";
  bottomRight?: (card: T) => ReactNode;
  finish?: (card: T) => Finish | null;
  treatment?: (card: T) => readonly Treatment[];
  gameChanger?: (card: T) => boolean;
  action?: (card: T) => ReactNode;
  column?: (card: T) => ReactNode;
  caption?: (card: T) => ReactNode;
  money?: (card: T) => ReactNode;
  cardMenu?: (card: T) => ((e: ReactMouseEvent) => void) | undefined;
  cardMenuKey?: (card: T) => ((e: ReactKeyboardEvent) => void) | undefined;
  tileRef?: (card: T, element: HTMLElement | null) => void | (() => void);
  dragPayload?: (card: T) => DragPayload | null;
  dragRecord?: (card: T) => Record<string, unknown> | null;
  /**
   * The **other** cards a drag from this tile carries — issue #214, and empty for every ordinary
   * drag. Hold it still, like the two slots above it: its identity is in the registration's
   * dependency list.
   */
  dragRest?: (card: T) => DragPayload[];
}) {
  const mark = badge?.(card);
  const corner = topLeft?.(card);
  const footMark = bottomRight?.(card);
  const tileFinish = finish?.(card) ?? null;
  const tileTreatments = treatment?.(card) ?? [];
  const crowned = gameChanger?.(card) ?? false;
  /**
   * What the chin says about the printing — **branched here rather than passed as four loose
   * props**, because `CardChin`'s own prop is a union with exactly two arms and that is the point
   * of it: either the caller wrote the line, or the chin builds `SET · number` from the two halves
   * of it. `printing={caption ? caption(card) : undefined}` would not type-check, and `undefined`
   * is not how you decline an arm.
   *
   * **`printingTitle: null` on the caller's arm, deliberately.** That arm requires it, for the
   * reason `CardChin` gives at the prop: a caller whose line reads "Any printing" must not get a
   * hover naming the cardboard it happens to be drawn as. No wall of this component has a set
   * *name* on its rows to give, so the default arm passes none either and the line stands on its
   * own — which is exactly what the caption did before this.
   */
  const printingLine = caption
    ? { printing: caption(card), printingTitle: null }
    : { setCode: card.setCode, collectorNumber: card.collectorNumber };
  /**
   * Opening the card, or nothing at all — see {@link GridCard.id} for the row that has no
   * printing to open. One binding for all three places a press opens the card (the art and
   * both corner marks), so a wall cannot end up half-live.
   */
  const open = card.id ? (event: ReactMouseEvent) => onSelect(card, event) : undefined;

  /**
   * **The caller's controls leave the Tab order with the art** — see {@link tabStop}.
   *
   * By hand rather than by prop, because they are the caller's elements: this file cannot hand
   * `QuantityStepper`'s buttons a `tabIndex`, and a slot signature that took one would make every
   * caller thread it through. So each tabbable descendant is set to `-1` with what it had kept
   * beside it ({@link HELD_TAB_ATTR}), and put back when the tile becomes the stop.
   *
   * **After every commit, not on `tabStop` alone**: a slot re-renders with the tile and may mount a
   * control that was not there last time (a stepper appearing with the first copy), and a caller
   * that re-sets its own `tabIndex` is picked up again, because only what is currently tabbable is
   * matched. `holding` keeps a wall of stops — every wall without the arrows — from querying at
   * all. Neither the art (the prop below) nor anything already `-1` is touched.
   */
  const artRef = useRef<HTMLButtonElement>(null);
  const holding = useRef(false);
  useLayoutEffect(() => {
    if (tabStop && !holding.current) return;
    const tile = artRef.current?.closest<HTMLElement>(TILE_SELECTOR);
    if (!tile) return;
    if (tabStop) {
      holding.current = false;
      for (const el of tile.querySelectorAll<HTMLElement>(`[${HELD_TAB_ATTR}]`)) {
        const was = el.getAttribute(HELD_TAB_ATTR) ?? "";
        el.removeAttribute(HELD_TAB_ATTR);
        // Only a `-1` that is still ours is put back; a caller that has since set its own value
        // keeps it.
        if (el.getAttribute("tabindex") !== "-1") continue;
        if (was === "") el.removeAttribute("tabindex");
        else el.setAttribute("tabindex", was);
      }
      return;
    }
    for (const el of tile.querySelectorAll<HTMLElement>(TABBABLE)) {
      if (el === artRef.current) continue;
      el.setAttribute(HELD_TAB_ATTR, el.getAttribute("tabindex") ?? "");
      el.setAttribute("tabindex", "-1");
      holding.current = true;
    }
  });

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
      if (!element) return detach;
      // `null` from either slot is a card that cannot be picked up. Decided **here** rather than
      // inside the thunk because the thunk is read at `dragstart`, by which point the drag has
      // begun: a source that is registered is a source, so the answer has to come before the
      // registration. The one live case is an *orphan* — no printing, so a `{kind:"card"}` payload
      // would carry an empty id, which addresses every row and no row (`dnd.ts`).
      //
      // `dragRecord` wins where both are passed, and no caller passes both: they are the same
      // seam at two widths, and one element takes one `draggable()`.
      if (dragRecord) {
        const record = dragRecord(card);
        if (record === null) return detach;
        const stop = composedDraggable({
          element,
          data: () => {
            const now = dragRecord(card) ?? record;
            // **The group is added to the composed record rather than built into it** — this is
            // the seam for a tile whose drag means more than one thing (the wishlist's, which
            // carries a wish mark beside the card one), so the record is the caller's and only
            // the group is ours. The primary is recovered through `readDragData` instead of
            // being passed a second time, so the head of the group and the flat payload beside
            // it can never name different cards. A record with no readable card payload — an
            // any-printing wish — gets no group, which is right: there is no card in it to
            // carry others alongside.
            const primary = readDragData(now);
            return primary === null ? now : withDragGroup(now, primary, dragRest?.(card) ?? []);
          },
        });
        return () => {
          stop();
          detach?.();
        };
      }
      if (!dragPayload) return detach;
      const carried = dragPayload(card);
      if (carried === null) return detach;
      const stop = cardDraggable({
        element,
        payload: () => dragPayload(card) ?? carried,
        rest: dragRest ? () => dragRest(card) : undefined,
      });
      return () => {
        stop();
        detach?.();
      };
    },
    [tileRef, dragPayload, dragRecord, dragRest, card],
  );

  return (
    // A wrapper rather than one big button: the tile carries a control of its own, and a button
    // inside a button is invalid HTML that React warns about and browsers render as they please.
    // The art is the button; the quick-add is its neighbour in the strip over the picture's foot.
    <div
      ref={attach}
      // The tile's place in the list, for the arrow-key walk — on the root because a press can
      // land on any of a tile's parts (the art, either corner, the action strip, the chin) and
      // only this box contains all of them. Written out rather than built from
      // `GRID_INDEX_ATTR`, which is the spelling the reading end uses; the two are one file
      // apart on purpose, since a JSX attribute assembled from a constant is a name neither the
      // browser's devtools nor a reader can grep for.
      data-grid-index={gridIndex}
      // The whole tile, rather than the art button inside it: a right-click on the chin, on
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
      // them wherever the caller puts it, corners and chin alike, and nothing outside a tile
      // ever sees them.
      style={{ width, ...cardScaleVars(zoom) }}
      // **`scroll-m-1.5` is room for the focus ring, and it is the arrow walk that needs it.**
      //
      // `scrollIntoView({ block: "nearest" })` parks a tile flush against the scrollport's edge,
      // and a scrollport is the **padding box** — so the wall's own `p-3` buys nothing at an
      // intermediate scroll position, and the ring `FOCUS` paints 4px proud of the tile's border
      // box lands in the clipped region. That is `DROP_MARK_ROOM`'s rule
      // (`src/lib/dropMarks.ts`) arriving by a different road: a scroller has to leave room for
      // the marks its own targets draw outside their border box, and half a focus indicator is
      // a WCAG 2.4.7 failure rather than a cosmetic one. **6px rather than 4** is that constant's
      // own choice, kept so the two numbers cannot drift.
      //
      // A scroll margin rather than more padding, because padding does not move where
      // `scrollIntoView` stops. It also absorbs the **2px** the walk was measured overshooting
      // by (2026-08-18, debug build, 1280×800, arrowing down a 117k-card browse): the virtualiser
      // owns this scroller's offset and the tile's final transform lands in the same commit the
      // scroll is computed in, so the correction is a fraction of the ring's room rather than
      // something needing a frame of its own.
      //
      // **A second ring paints in that room now and 6px still covers both**, which is worth
      // saying because the two are not stacked: the selection ring below is `ring-2` on *this*
      // box — 2px outside the same border box — and `FOCUS`'s indicator is 4px proud of it, so the
      // furthest either reaches is 4. What changed is only *whose* box the gold is on. Before this
      // it was `CardArt`'s frame, one level in, where the tile's own padding-free geometry meant
      // the ring was already inside the scroll margin by construction; on the root it needs the
      // margin the focus ring already asked for, and asks for no more of it.
      // **No gap between the art and the chin.** The chin is *attached* to the card — it rides
      // `CHIN_RISE` up over the face's clipped corners so the two are one piece of cardboard — and
      // a gap here would separate exactly what that rise exists to fuse. It used to be `gap-1`,
      // budgeted into the row's height as `CAPTION_GAP`; both are gone together.
      //
      // **And the gold ring goes around the whole of that piece of cardboard, which is why it is
      // here and not on the art.** It was `CardArt`'s until this change — the frame draws its own
      // `ring-2 ring-accent` on `selected`, and this tile passed the flag straight through — so
      // the ring stopped where the picture stopped and the chin hung outside it: an outlined
      // photograph glued to an unoutlined bar, which contradicts the one thing `CHIN_RISE` exists
      // to say. The tile is one object, so the outline is one outline. (`CardArt` keeps the prop
      // and every other caller keeps the behaviour: `AllPrintingsDialog` and the deck views draw
      // the frame directly, and there the art genuinely *is* the whole object.)
      //
      // `rounded-lg` is what the ring traces, and it is measured rather than guessed:
      // `src/index.css` sets `--radius: 0.625rem` with `--radius-lg: var(--radius)`, so this is
      // 10px — the same 10px `CardArt`'s frame uses on its top corners and `CardChin`'s
      // `rounded-b-lg` uses on its bottom ones. One radius, drawn once around both.
      //
      // **It costs the wall no layout.** A `ring` is a spread-only outset box shadow painted
      // *outside* the border box, so the tile's width and `tileHeight` — and with them the row
      // pitch the virtualiser is measuring — are exactly what they were with no ring at all.
      className={cn(
        "group flex shrink-0 scroll-m-1.5 flex-col rounded-lg",
        selected && "ring-2 ring-accent",
      )}
      // A Shift-click is a range (issue #214), and Shift in a browser also drags a text selection
      // across everything between the two presses — on a wall of forty tiles, every chin from
      // the anchor to the pointer painted blue for the length of the gesture. On the tile's root
      // rather than on the art button, because the press can land on any of its four parts.
      onMouseDown={suppressRangeSelection}
    >
      {/* The badge is a *sibling* of the button, not a child of it: inside, its text would
          join the button's accessible name, and a wall of forty cards would be forty
          buttons called "Lightning Bolt 3 in your collection". */}
      <div className="relative">
        <button
          ref={artRef}
          type="button"
          onClick={open}
          // `-1` on every tile of an arrow-walked wall but its stop — see {@link tabStop}. Left
          // unset rather than `0` on a stop, so a wall without the arrows draws what it always did.
          tabIndex={tabStop ? undefined : -1}
          // Said rather than merely dead, on the one row that has no card to open. `aria-disabled`
          // and never `disabled`, like every other out-of-reach control in this app: the button
          // keeps its place in the tab order, and it is still what the arrow walk hands the caret
          // to (see {@link CARET_SELECTOR}) — a wall with an unreachable tile in the middle of it
          // would be worse than one with a tile that says it opens nothing.
          aria-disabled={card.id ? undefined : true}
          // The name is the card and nothing else — the quick-add beside it says what it
          // does to the card, and two buttons whose names both start with it would be two
          // buttons a screen reader cannot tell apart in a wall of forty.
          className={cn("block w-full rounded-lg text-left", FOCUS)}
        >
          {/* The frame, the picture, its retry and the no-art fallback all live in
              `CardArt` — five surfaces draw a card and this is the one definition of what
              that looks like. The button, the focus ring and the chin stay here, because
              they are what makes this frame a *tile* rather than a picture. */}
          <CardArt
            // `null`, not `""`: a row with no printing fetches nothing and gets the no-art
            // frame with its name, which is what `CardArt` draws for an orphan everywhere else.
            cardId={card.id || null}
            name={card.name}
            // **No `selected` here, deliberately.** The gold ring is drawn on the tile's root, so
            // it goes round the art *and* the chin as one object — see the root's `className`.
            // Passing it here as well would draw a second ring 28px above the first one's foot.
            finish={tileFinish}
            treatments={tileTreatments}
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
          // No keyboard handler, and none is owed: the corner duplicates a fact the chin
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
            onClick={open}
            // The inset, the padding and the corner are all sizes on a card at 100% zoom, and
            // scale with it — the mark inside already does, and a chip whose box held still would
            // either burst at 2× or swim in its own padding at 0.5×.
            //
            // **`badgeChrome` moves the backing and nothing else** — see the prop for why the
            // default is the one it is, and why one caller needs the other arm. Everything above
            // the branch is the corner: where it sits, that it disappears when it has nothing to
            // say, that it takes its own pointer events and opens the card. What `"bare"` drops is
            // the three classes that make a chip, because the marks inside it bring their own.
            className={cn(
              "pointer-events-auto absolute empty:hidden",
              "bottom-[calc(0.25rem*var(--mark-scale,1))] left-[calc(0.25rem*var(--mark-scale,1))]",
              badgeChrome === "chip" && [
                "bg-bg/85",
                "rounded-[calc(0.25rem*var(--mark-scale,1))]",
                "px-[calc(0.375rem*var(--mark-scale,1))] py-[calc(0.125rem*var(--mark-scale,1))]",
              ],
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
          // It is inset from the left by 4px rather than going flush, and that is the one thing
          // here that is not the badge's arrangement copied: the corner is a *sibling* of the
          // button, so the art's `rounded-lg` does not clip it, and a box at 0,0 would hang off
          // the picture's rounded corner. **How far down it sits is the caller's** — see
          // {@link CardGrid}'s `topLeftPlacement`, which exists because the two walls that draw a
          // mark here want two different answers and both are right.
          <span
            onClick={open}
            // The badge's box, scaled the same way — and here the scaling pays a debt the search
            // page's own comment recorded: this corner was 4px in so that it cleared the art's
            // rounded edge and landed on the printed nameplate, and *because it did not scale*, by
            // 2× it had climbed out of the nameplate into the border strip above it. 4px of a
            // doubled card is 8px, which is the same place on the picture. Both offsets below
            // scale for that reason, and both are written out in full rather than built — a
            // Tailwind class assembled from a variable emits no rule at all.
            className={cn(
              "pointer-events-auto absolute bg-bg/85 empty:hidden",
              "left-[calc(0.25rem*var(--mark-scale,1))]",
              topLeftPlacement === "clear"
                ? "top-[calc(2rem*var(--mark-scale,1))]"
                : "top-[calc(0.25rem*var(--mark-scale,1))]",
              "rounded-[calc(0.25rem*var(--mark-scale,1))]",
              "px-[calc(0.375rem*var(--mark-scale,1))] py-[calc(0.125rem*var(--mark-scale,1))]",
            )}
          >
            {corner}
          </span>
        )}
        {footMark && (
          // The fourth corner, and the exact mirror of the badge — same box, same felt, same
          // scaled radius and padding, same `empty:hidden`, same pointer events and the same
          // click that opens the card. Built from the badge's classes rather than beside them on
          // purpose: four corners decided in four places is four insets, four radii and four
          // shades of backing, which is the drift `topLeft` already stopped once.
          //
          // A *sibling* of the art button like the other two, so its words never join the
          // button's accessible name — see the badge's comment above, which is the whole of the
          // reasoning for all three.
          //
          // **The `action` strip lies over this corner** (`inset-x-0 bottom-0 justify-end`), so a
          // wall passing both slots is asking two things to own one place. None does: see
          // {@link CardGrid}'s `bottomRight`.
          <span
            onClick={open}
            className={cn(
              "pointer-events-auto absolute bg-bg/85 empty:hidden",
              "bottom-[calc(0.25rem*var(--mark-scale,1))] right-[calc(0.25rem*var(--mark-scale,1))]",
              "rounded-[calc(0.25rem*var(--mark-scale,1))]",
              "px-[calc(0.375rem*var(--mark-scale,1))] py-[calc(0.125rem*var(--mark-scale,1))]",
            )}
          >
            {footMark}
          </span>
        )}
        {action && (
          // **Over the art, not in the chin** — there is no room for a 20px control beside a
          // price at 170px, and this is where the deck editor already puts a card's stepper. It
          // is absolutely positioned, so it costs the wall no height and `tileHeight` is
          // unchanged by its existence.
          //
          // `relative` here rather than on the chin, because it is what the 256px popup hangs
          // off: a popup on a 170px tile has to open from the tile's *left* edge, or the first
          // column's opens left of the scroller — and left overflow, unlike right, cannot be
          // scrolled back into view. Both callers pass their control `static` for exactly that,
          // and this box is the same width the caption was.
          //
          // Revealed on hover **and on focus-within**, and never removed from the tab order:
          // "visible on hover" is not a state a keyboard has. (On an arrow-walked wall it leaves
          // with its whole tile when that tile is not the stop — see `tabStop` — and is back the
          // moment the walk reaches it.)
          //
          // **`pointer-events-none` on the strip, `auto` on what it holds** — `FoilOverlay`'s
          // arrangement, and here it is what keeps the card openable. The strip is the tile's full
          // width for the anchoring reason above, it lies *over* the art, and an `opacity-0`
          // element is still a hit target — so without this the bottom ~28px of every card on
          // five walls would swallow the press that opens it, and the reader would find a band
          // across the foot of the picture that simply does not respond. jsdom has no layout
          // engine and therefore no hit testing, so nothing in the suite can go red for the
          // behaviour; the two classes are pinned instead.
          //
          // **Open, on a touch screen: the control this strip holds is invisible and still
          // pressable, and it is 20.4px.** `AnchoredPopup`'s trigger is 24px × `CONTROL_SHRINK`,
          // under WCAG 2.5.8's 24×24 floor — and the sentence above is what makes that more than
          // a sizing complaint: `opacity-0` is a hit target, and a finger has no hover to reveal
          // it with. So a reader tapping the bottom-right of a card to open it opens a quick-add
          // popup instead, with nothing on screen having said the control was there.
          //
          // **Growing the target under `coarse:` was tried and rejected** (2026-08-29, G1's
          // round). It is the shape `ActiveFilterChip` uses — a transparent `::before` carrying
          // `var(--target-min)` over smaller ink — and it is the wrong medicine here, twice over:
          // the target is already the problem rather than the cure, so 44px would make the
          // invisible trap 44px; and centred on a control in this strip it would reach up over
          // the art and down past the chin, which on the deck panel's 150px tile is nearly a third
          // of the card's width. What this actually wants is a decision about *visibility* on a coarse pointer
          // — always drawn, or not drawn at all — and that is a design round rather than a
          // measurement, since "a wall of art is not a wall of plus signs" is `REVEAL_ON_HOVER`'s
          // own argument for the reveal.
          <span
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 flex justify-end",
              "[&>*]:pointer-events-auto",
              "px-[calc(0.25rem*var(--mark-scale,1))] py-[calc(0.25rem*var(--mark-scale,1))]",
              REVEAL_ON_HOVER,
            )}
          >
            {action(card)}
          </span>
        )}
        {column && (
          // **Up the right-hand side, over the art** — the deck stack's position for a card's
          // stepper, and the whole of what issue #348 asked for: one control in one place across
          // the deck editor and the two walls.
          //
          // **The box spans the tile and right-aligns its contents**, which is the strip's
          // arrangement above and is here for exactly the strip's reason. It used to hug its
          // content — roughly 31px wide, pinned at `right-[4px]` — on the argument that nothing
          // was anchored off it so it needed no width, and that a narrow box is a narrow collision
          // list. Both halves of that stopped being true when the wishlist moved its edit pencil
          // in here: the pencil is an `AnchoredPopup` passed `static` (as every one of these on a
          // card is, so its own root drops out of the chain), whose `w-72` (288px) `align="start"`
          // panel is then `absolute left-0` against **this** box. Against a 31px box sitting 4px
          // from the right edge of a 170px tile, `left-0` is ~135px in and the panel runs ~253px
          // off the right-hand edge of the scroller, clipped. Against a box that spans the tile,
          // `left-0` is the tile's own left edge — which is what the `action` strip already does, and
          // `AnchoredPopup`'s `align="start"` writes down why: a panel opening leftwards off the
          // first column is clipped by the scroller, and left overflow, unlike right, cannot be
          // scrolled back into view.
          //
          // **`pointer-events` follow the reveal, and here that is load-bearing rather than tidy —
          // but the gate is now on the *children*.** An `opacity-0` element is still a hit target;
          // the strip pays for that with `pointer-events-none` plus `auto` on what it holds, which
          // leaves the control pressable while invisible. That trade is affordable across a 20px
          // strip and is not across this column: it stands ~99px tall against a 238px face, so a
          // reader tapping the right-hand third of a card to open it would step the quantity of a
          // card they cannot see the controls for. Spanning the tile makes that band the card's
          // whole width, so the gate matters more rather than less — and it cannot stay on the
          // wrapper, because a wrapper that takes pointer events at all would swallow the press
          // that opens the card everywhere the control is not. So: the wrapper is
          // **always** pointer-transparent, and the child inherits `none` until the tile is
          // hovered or holds focus. A mouse loses nothing (the pointer that would press the
          // control has already revealed it by being on the tile), and a touch screen keeps the
          // only gesture it ever had here.
          //
          // `group-focus-within` is not decoration either: `AnchoredPopup`'s trigger holds focus
          // while its panel is up, so without it an *open* popup's own contents would go dead the
          // moment the pointer left the tile.
          <span
            className={cn(
              "pointer-events-none absolute inset-x-0 flex justify-end",
              // The top-right corner is the finish chip and the game-changer crown (`CardArt`),
              // laid out entirely on `--mark-scale` — inset 4px and 16px tall at 1×. 24px on that
              // **same** variable is what clears them at every stop of the ladder rather than at
              // 1× alone. A flat 24px would clear at rest and be **swallowed at 2×**, where the
              // chip's own foot has reached 40px — the direction `SearchPage`'s printings chip
              // failed in when it was held at 4px, one card over. Measured in Storybook
              // (2026-09-03, `collection-page--stepping-from-the-wall`, a foil tile): the chip is
              // 8/16/32px tall at 0.5×/1×/2× and this box starts at 12/24/48, so the gap is
              // 1/3/7px — narrowest at the bottom of the ladder and, because both boxes are
              // linear in the same zoom, incapable of inverting. The right inset is the two corner
              // marks' own 4px — `pr-` rather than `right-` now that the box spans the tile, so
              // the column still stands in the same gutter they do.
              "top-[calc(1.5rem*var(--mark-scale,1))] pr-[calc(0.25rem*var(--mark-scale,1))]",
              "[&>*]:pointer-events-none",
              "group-hover:[&>*]:pointer-events-auto group-focus-within:[&>*]:pointer-events-auto",
              REVEAL_ON_HOVER,
            )}
          >
            {column(card)}
          </span>
        )}
      </div>

      {/* The card's foot — `components/CardChin`, which is the deck stack's, and the one
          definition of what a foot looks like on any surface in this app. The rarity gem, the
          printing, the finish and the price, in the data face and one step dimmer. */}
      <CardChin
        zoom={zoom}
        rarity={card.rarity}
        {...printingLine}
        finish={tileFinish}
        treatments={tileTreatments}
        money={money?.(card)}
        // **`"art"`.** `CardArt` draws its own edge and stops where this bar begins, so the chin
        // supplies all three of its own and the two read as one outline. See the prop.
        seam="art"
        // **The crown only, and the finish is deliberately not here beside it.**
        //
        // This slot used to carry both, because the art's chip is `aria-hidden` — it sits inside
        // the tile's button, where any text of its own would join the button's accessible name and
        // make a wall of foils forty buttons called "… Foil" — so the tile stated the words itself
        // in a sibling of that button. The chin's own `FinishMark` **is** that sibling now, and it
        // states them through its `aria-label`: an `sr-only` word beside it made a foil card say
        // "Foil" twice.
        //
        // **The two conditions match on every row but one, and the exception is deliberate.** The
        // word was drawn when `treatmentTitle(treatments)` or `finish` said something; `CardChin`
        // draws the mark on `finish !== null || treatments.length > 0`; and `FinishMark`'s label is
        // the same `named ?? FINISH_LABEL[finish]` the word was built from. So `foil`, `etched` and
        // every named copy — a Serialized *nonfoil* included, whose non-empty `treatments` draw the
        // glyph over a plain finish — say exactly what they said before.
        //
        // **The exception is a plain `nonfoil` with no treatments**, where the span used to say
        // `, Nonfoil` and `FinishMark` returns `null`. That is not a hole this file should patch:
        // *nonfoil goes unmarked* is the app's rule rather than the mark's convenience — it is the
        // finish a price is assumed to be, and 61 % of the corpus has a foil version, so a mark on
        // every plain card is chrome (`CardChin`'s `finish` prop carries the measurement). Restoring
        // the word here would say `Nonfoil` on the majority of every wall while the picture beside
        // it says nothing, which is the louder half of the trade rather than the quieter. And on
        // the one wall where a *stored* `nonfoil` is a fact the reader chose rather than a default
        // — the collection's, which draws a tile per printing **and finish** — the caption already
        // prints the finish in words, so nothing there goes unsaid.
        //
        // The crown has no such twin. `GameChangerMark` is drawn only inside the `aria-hidden`
        // overlay and the chin has no slot for it, so this span is still the only thing that says
        // it. Turning the art's chip off would take the crown with it — `FoilOverlay`'s `mark`
        // governs both — which is why the *glyph* is drawn twice on this wall and the *word* once.
        extra={crowned && <span className="sr-only">, {GAME_CHANGER_LABEL}</span>}
      />
    </div>
  );
}
