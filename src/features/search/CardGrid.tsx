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
import { keepCaretForCard } from "@/lib/caretWalk";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import { nextGridIndex } from "./gridNav";
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
 * A tile's **absolute** position in `rows`, published on its own root element.
 *
 * The DOM is the caret's data structure here, exactly as it is for the context menu's rows
 * (`components/menu/panel.ts` argues the same point at greater length): a keypress arrives with
 * a `target`, and walking up from it to the tile it landed in is one `closest` — where mapping
 * that element back to a *card* through the `rows` array would mean keeping a second index of
 * something the browser is already holding.
 *
 * It goes on the tile's root rather than on the art button inside it because a press can land on
 * any of a tile's four parts — the art, either corner mark, the quick-add in the caption — and
 * only the root contains all of them. The element that eventually takes the caret is a different
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
 * The art button is a tile's first `<button>` in document order: the two corner marks between it
 * and the caption are `<span>`s, and the caller's own control (the search's quick-add) comes
 * after it in the caption. `?? tile` is the fallback for a wall drawn without art at all, which
 * no caller builds today.
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
  arrowNav = false,
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
   * Whether the arrow keys walk the wall — left and right one tile, up and down one row — and
   * **move the selection with them**, so the card the detail pane is showing follows the caret.
   *
   * That last part is what makes this a prop rather than a behaviour. Every press calls
   * {@link onSelect}, which on the two walls that pass this *is* the store's `selectedCardId` and
   * therefore what the docked 384px `CardDetailPane` reads — the reader asked for the next card
   * to be *selected*, not merely outlined, and a focus ring that moved while the pane held still
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
   */
  arrowNav?: boolean;
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
  const select = useCallback(
    (cardId: string) => {
      if (arrowNav) keepCaretForCard(cardId);
      onSelect(cardId);
    },
    [arrowNav, onSelect],
  );

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length
    ? Math.min(rows.length - 1, (virtualRows[virtualRows.length - 1].index + 1) * columns - 1)
    : -1;

  // A new list reuses this scroll container, and a browser clamps the old offset into
  // the new content rather than resetting it.
  //
  // A caret waiting on a tile goes with the old list. The index is a position in `rows`, and a
  // new search's row 40 is a different card — chasing it would scroll a reader who has just
  // retyped their query down to whatever landed there.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
    setPendingIndex(null);
  }, [listKey, virtualizer]);

  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

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
    if (pendingIndex >= rows.length) {
      setPendingIndex(null);
      return;
    }
    // A wall that has drawn no rows at all — measured at zero height, or between lists — has
    // nothing to focus and nothing to scroll onto. Read here rather than only named in the
    // dependency array, because a dependency that the body never looks at is one a later reader
    // deletes as noise, and this effect's whole timing rests on it.
    if (virtualRows.length === 0) return;
    const tile = scrollRef.current?.querySelector<HTMLElement>(
      `[${GRID_INDEX_ATTR}="${pendingIndex}"]`,
    );
    if (!tile) {
      virtualizer.scrollToIndex(Math.floor(pendingIndex / columns));
      return;
    }
    const caret = tile.querySelector<HTMLElement>(CARET_SELECTOR) ?? tile;
    caret.focus({ preventScroll: true });
    // **The tile is what is scrolled, and the button inside it is what takes the caret.** They
    // are not the same box and scrolling the wrong one is measurable: the button is the art
    // alone, so bringing *it* into view leaves the caption strip under it hanging past the
    // scrollport, and the scroll margin that makes room for the focus ring is on the tile and
    // does not reach a descendant. Measured 2026-08-18 in the shipped window arrowing down a
    // 117k-card browse: the tile's foot sat **2px** past the scroller's padding box every step,
    // where scrolling the tile lands it the intended **6px** clear.
    tile.scrollIntoView?.({ block: "nearest" });
    setPendingIndex(null);
  }, [pendingIndex, virtualRows, columns, rows.length, virtualizer]);

  /**
   * One arrow press: move the selection, and take the caret with it.
   *
   * **One handler on the scroller rather than one per tile**, which is the same economy every
   * other callback on this component is written for — an unfiltered browse is ~117 k rows, and a
   * fresh closure per tile is what `dragPayload` and `gameChanger` each carry a paragraph asking
   * callers not to do. Keydown bubbles, so a press on the art button, on a corner mark or on the
   * caption all arrive here with a `target` inside the tile it happened in.
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
   *   own caption. See the check itself for the two positions that do count.
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
    // `role="dialog"` drawn *in the tile's caption* — `SearchPage` passes it `static` so a 256px
    // panel on a 170px tile opens from the tile's own left edge — so a reader stepping through
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

    const next = nextGridIndex(Number(from.dataset.gridIndex), e.key, columns, rows.length);
    if (next === null) return;

    e.preventDefault();
    // `select` rather than `onSelect`: the caret note lives in there, so a *press* on a tile gets
    // it too and the reader's first arrow after clicking has somewhere to move from.
    select(rows[next].id);
    // Scroll first, focus later. The tile may not be drawn yet — see `pendingIndex` — and the
    // virtualiser is the only thing that can put it on screen, since it owns this scroller's
    // offset outright.
    virtualizer.scrollToIndex(Math.floor(next / columns));
    setPendingIndex(next);
  };

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label={label}
      // No `tabIndex`: every tile is a button, so the scroller is reachable and
      // scrollable from the keyboard through its own contents. A tab stop on the box
      // around them would be one more press between the reader and the cards.
      //
      // Which is also why the arrow keys are listened for **here** rather than on the tiles: this
      // box holds no caret of its own, it holds every tile, and one listener is one closure
      // instead of 117 k. The handler bails on a wall that was not given `arrowNav`.
      onKeyDown={onArrowKey}
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
                // Where this tile sits in `rows` — not in the row it is drawn in. See
                // `GRID_INDEX_ATTR` for why the absolute number is the one that survives the
                // reflow an arrow press causes.
                gridIndex={v.index * columns + i}
                width={tileWidth}
                zoom={cardZoom}
                onSelect={select}
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
  gridIndex,
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
  /**
   * Where this tile sits in the whole list, published as `data-grid-index` on its root.
   *
   * Unconditional, and never a function of whether the wall takes the arrow keys — see
   * {@link GRID_INDEX_ATTR}, which is where the reasoning for the attribute lives.
   */
  gridIndex: number;
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
      // The tile's place in the list, for the arrow-key walk — on the root because a press can
      // land on any of a tile's four parts (the art, either corner, the caption's control) and
      // only this box contains all of them. Written out rather than built from
      // `GRID_INDEX_ATTR`, which is the spelling the reading end uses; the two are one file
      // apart on purpose, since a JSX attribute assembled from a constant is a name neither the
      // browser's devtools nor a reader can grep for.
      data-grid-index={gridIndex}
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
      className="group flex shrink-0 scroll-m-1.5 flex-col gap-[calc(0.25rem*var(--mark-scale,1))]"
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
