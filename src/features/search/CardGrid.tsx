import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import { cardScaleVars, CHIN_RISE, chinHeight, scaled, type ZoomSection } from "@/lib/cardZoom";
import { keepCaretForCard } from "@/lib/caretWalk";
import type { Finish } from "@/lib/finish";
import type { Treatment } from "@/lib/treatment";
import { FOCUS } from "@/lib/focus";
import { WALL_CARD_VARIANT, type ImageVariant } from "@/lib/images";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { NO_SELECTION, suppressRangeSelection, useCardSelection } from "@/lib/useCardSelection";
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
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string | null;
  /**
   * The front face's picture on `cards.scryfall.io`, by variant — **the only art a browser can
   * reach**, and absent on every wall but the search's.
   *
   * `search_cards` is the one card-bearing command the web build routes, so it is the one row
   * shape that carries this; the collection's, the wishlist's and the deck editor's walls do not
   * function in a browser at all and widening their DTOs would cost three payloads on desktop to
   * change nothing anywhere. Optional for exactly that reason, and `undefined` is a real answer
   * rather than a gap.
   *
   * `Partial`, and the tile must read the one variant it draws and treat a miss as "no art":
   * a printing whose only URL is Scryfall's `soon.jpg` placeholder carries **nothing** here,
   * because the backend refuses a URI it cannot version or one from a host that does not serve
   * card art. Never build a URL of your own from a missing entry.
   *
   * What decides whether it is *used* is `cardArtSrc` in `@/lib/images`, through `CardArt`'s
   * `imageUrl`: on desktop the local cache wins and this is ignored. Nothing in this file knows
   * which build it is in.
   */
  imageUris?: Partial<Record<ImageVariant, string>> | null;
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
 * How wide a tile is on a phone, in px — what the four page-width walls pass as
 * {@link CardGrid}'s `baseTileWidth` below `PHONE_PX`, and nothing else does.
 *
 * **The arithmetic, measured in the shipped WebView2 at 390×844 on 2026-08-29.** A 390px window
 * with the bottom tab bar drawn instead of the rail spends nothing on a rail, 40 on `AppShell`'s
 * `main` `p-5` and 26 on this wall's own scroller `border` + `p-3`: **324px of wall**. Then
 * {@link columnsFor}, which is the only arbiter here:
 *
 * - `columnsFor(324, 170)` is **1** — the standard tile, one column with 90px of margin either
 *   side of it. That is the failure this width exists to answer.
 * - `columnsFor(324, 160)` is **1** as well, and it is the trap: 160 looks like a fix, divides to
 *   1.95 columns and floors to the same single card. It is what the 9a round's draft suggested,
 *   and it is the same failure arriving one inset later.
 * - `columnsFor(324, 144)` is **2**, and the leftover is exactly 24 — so {@link sideGutterFor}
 *   splits it into 12 either side and the gutter is {@link GAP}. That is why 144 rather than
 *   156, which is the largest tile two of which fit at 324.
 *
 * ⚠️ **All of the above is about a 390px window, and the phone this was driven on is 360 — which
 * is why the number is 141 and not 144.** Measured on the device 2026-08-29 (OnePlus, Chrome 152,
 * portrait): `innerWidth` **360**, so `main`'s content is 320 and this wall is **294**, and
 * `columnsFor(294, 144)` is **1**. The rows came back 226 × 294 carrying one tile each — 144
 * missed its second column by **three pixels** on real hardware, against a `PHONE_PX` of 390 that
 * 9a picked as "a hard case… within a pixel or two of the common Android flagship". It was not
 * the hard case.
 *
 * **141 is the largest tile two of which fit at 294**, and it holds at both widths: two columns at
 * 294 and at 324. Its gutter at 294 is **0** — the pair exactly fills the row — and that is
 * acceptable here where 156's zero gutter at 324 was not the reason 144 won: {@link sideGutterFor}
 * pads the **row**, inside the box the `ResizeObserver` measures, and the scroller's own `p-3`
 * sits *outside* that, so a tile with no gutter is still 12px from the scroller's border box. The
 * wall does not scroll horizontally — `documentElement.scrollWidth` equalled `innerWidth` on the
 * device — so nothing here reaches the scrollport's edge. At 324 the gutter is 15.
 *
 * **Below about 320px of window even 141 floors at one column** (a 254px wall), and nothing
 * reasonable fixes that: two columns of *readable* card art stops existing somewhere, and this is
 * roughly where.
 *
 * A `grid` image is 488px wide, so this is a deeper downscale and never a blowup — the same thing
 * the deck panel's 150 already relies on. The reader's zoom scales *this*, exactly as it scales
 * {@link TILE_BASE_WIDTH}, so a phone at 2× draws one 288px card and the gesture keeps its meaning.
 *
 * **What this does not fix, and the decision that goes with it: the chin does not scale with the
 * tile, and that is accepted.** `--mark-scale`/`--control-scale` are published by
 * `cardScaleVars(zoom)` and know nothing about this prop, so the chin stays 28px of 10px type and
 * becomes proportionally *taller* on a narrower card — 12.6% of tile height here against 10.7% at
 * 170. It is accepted because the chin's contents are **type at the app's floor**: 10px is already
 * the smallest interface size in the chrome ladder, and 141/170 would put it at 8.3px, which is
 * not a smaller chin but an unreadable one. The proportion is the wrong measurement to optimise —
 * the readable size is. Tying the marks to `baseTileWidth` instead would also silently redraw the
 * deck panel's 150px wall, a shipped surface with no phone in it. A reader who wants the chin
 * smaller relative to the art already has the control that does it: the zoom scales both.
 *
 * **And what stays open**: the quick-add trigger over the art is `24 × CONTROL_SHRINK` = 20.4px,
 * under WCAG 2.5.8's 24, and `opacity-0` — see the `action` strip below, where the rest of that
 * note is.
 */
export const PHONE_TILE_WIDTH = 141;

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
  topLeftPlacement = "nameplate",
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
}: {
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
   */
  action?: (card: T) => ReactNode;
  /**
   * A control standing **on end in the tile's right margin**, over the art — the deck stack's
   * position for a card's stepper, brought to the walls by issue #348.
   *
   * Its own slot rather than a second thing hung in {@link action}, for the reason every corner
   * of a tile has exactly one owner: the strip is a *row* at the foot (`justify-end`, and the
   * wishlist already has a pencil in it), and a column standing up the right-hand side is a
   * different piece of geometry with a different collision list. Hanging both off one slot would
   * make the caller responsible for un-picking the strip's own layout, which is how two walls
   * drift into two arrangements.
   *
   * The box is `absolute`, so it costs the wall no height and `tileHeight` is unchanged by its
   * existence — the strip's property, for the strip's reason.
   *
   * **Where it starts is not the strip's 4px**: the top-right of a tile is already the finish
   * chip and the game-changer crown (`CardArt`), so the column begins below them. 24px on
   * `--mark-scale` is that chip's own box — a 4px inset over ~14px of chip — so the two clear
   * each other at every stop of the zoom rather than at 1× only.
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

  const columns = columnsFor(width, tileSize);
  const rowCount = Math.ceil(rows.length / columns);
  const tileWidth = tileWidthFor(width, tileSize);
  const gutter = sideGutterFor(width, tileSize);

  // The chin is **attached** to the card rather than spaced under it, so there is no gap in this
  // budget any more — the tile is the art plus the chin less the rise, which is exactly what
  // `chinHeight` and `CHIN_RISE` say. It used to be a budget for the quick-add button in the
  // caption; that control is over the art now and costs the wall no height at all.
  const captionHeight = chinHeight(cardZoom) - CHIN_RISE;
  const tileHeight = Math.round(tileWidth * (7 / 5)) + captionHeight;

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

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller,
    estimateSize: () => tileHeight + GAP,
    scrollMargin,
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
  const selectionOrder = useMemo(() => rows.map((card) => tileKey(card)), [rows]);
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
  const dragRef = useRef({ picked, rows, dragPayload, dragRecord });
  useEffect(() => {
    dragRef.current = { picked, rows, dragPayload, dragRecord };
  }, [picked, rows, dragPayload, dragRecord]);
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
    () => (picked.count > 1 ? rows.filter((card) => picked.selected(tileKey(card))) : []),
    [rows, picked],
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
    const tile = wallRef.current?.querySelector<HTMLElement>(
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
    // alone, so bringing *it* into view leaves the chin under it hanging past the
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

    const next = nextGridIndex(Number(from.dataset.gridIndex), e.key, columns, rows.length);
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
  };

  return (
    <div
      ref={wallRef}
      role="group"
      aria-label={label}
      // No `tabIndex`: every tile is a button, so the wall is reachable and
      // scrollable from the keyboard through its own contents. A tab stop on the box
      // around them would be one more press between the reader and the cards.
      //
      // Which is also why the arrow keys are listened for **here** rather than on the tiles: this
      // box holds no caret of its own, it holds every tile, and one listener is one closure
      // instead of 117 k. The handler bails on a wall that was not given `arrowNav`.
      onKeyDown={onArrowKey}
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
                // **The pane's card, or a member of the picked set** — one gold ring for both,
                // which is issue #214's answer rather than an economy: gold already means
                // *picked* on this wall, and a reader who has Ctrl-clicked four tiles has picked
                // four. The pane shows the last one they opened, as a pane always has.
                //
                // **Both halves key on the tile**, which is what stops a wall that draws a foil
                // and a nonfoil of one printing from ringing both when the reader pressed one —
                // see {@link tileKey}. `selectedId` is therefore a tile's identity on a wall that
                // has any, and a card id on the six that do not.
                selected={tileKey(card) === selectedId || picked.selected(tileKey(card))}
                dragRest={dragRest}
                badge={badge}
                topLeft={topLeft}
                topLeftPlacement={topLeftPlacement}
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
 * The chrome is a `CardChin` and a focus ring, plus whatever the caller hangs in the two corners
 * and in the action strip over the picture's foot. The rarity is the chin's 6px gem — the only
 * colour in the tile that is not the card's own, and a filled badge there would out-shout what it
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
  topLeftPlacement = "nameplate",
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
  topLeft?: (card: T) => ReactNode;
  topLeftPlacement?: "nameplate" | "clear";
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
      // **No gap between the art and the chin.** The chin is *attached* to the card — it rides
      // `CHIN_RISE` up over the face's clipped corners so the two are one piece of cardboard — and
      // a gap here would separate exactly what that rise exists to fuse. It used to be `gap-1`,
      // budgeted into the row's height as `CAPTION_GAP`; both are gone together.
      className="group flex shrink-0 scroll-m-1.5 flex-col"
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
          type="button"
          onClick={open}
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
            // The picture a browser can reach, where the row carries one — see
            // {@link GridCard.imageUris}. `WALL_CARD_VARIANT` and not a size of this wall's own:
            // the constant's own comment is the argument (the wall zooms and the variant does
            // not, and `SearchPage`'s pre-warm has to be asking for the same key), and it is the
            // same constant `CardArt` defaults `variant` to — which this tile passes nothing for
            // — so the protocol URL and this one name one size and the two builds draw the same
            // picture.
            imageUrl={card.imageUris?.[WALL_CARD_VARIANT]}
            selected={selected}
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
          // "visible on hover" is not a state a keyboard has.
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
          // the art and down past the chin, which on a 144px phone tile is a third of the card's
          // width. What this actually wants is a decision about *visibility* on a coarse pointer
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
          // The box hugs its content rather than spanning the tile, which is the one thing that
          // makes it *unlike* the strip above: there is no popup anchored off it, so it needs no
          // width of its own, and a narrow box is a narrow collision list.
          //
          // **`pointer-events` follow the reveal, and here that is load-bearing rather than
          // tidy.** An `opacity-0` element is still a hit target — the strip's comment above says
          // so and pays for it with `pointer-events-none` plus `auto` on its children, which
          // leaves the *control* pressable while invisible. That trade is affordable across a
          // 20px strip and is not across this column: it stands ~99px tall against a 238px face,
          // so a reader tapping the right-hand third of a card to open it would step the quantity
          // of a card they cannot see the controls for. Gating the whole box instead costs a
          // mouse nothing — the pointer that would press it has already revealed it by being on
          // the tile — and gives a touch screen back the press that opens the card, which is the
          // only gesture it had here.
          //
          // `pointer-events` is inherited, so gating the wrapper gates the column inside it and
          // no `[&>*]` arm is needed.
          <span
            className={cn(
              "pointer-events-none absolute flex",
              "group-hover:pointer-events-auto group-focus-within:pointer-events-auto",
              // The top-right corner is the finish chip and the game-changer crown (`CardArt`),
              // laid out entirely on `--mark-scale` — inset 4px and 16px tall at 1×. 24px on that
              // **same** variable is what clears them at every stop of the ladder rather than at
              // 1× alone. A flat 24px would clear at rest and be **swallowed at 2×**, where the
              // chip's own foot has reached 40px — the direction `SearchPage`'s printings chip
              // failed in when it was held at 4px, one card over. Measured in Storybook
              // (2026-09-03, `collection-page--stepping-from-the-wall`, a foil tile): the chip is
              // 8/16/32px tall at 0.5×/1×/2× and this box starts at 12/24/48, so the gap is
              // 1/3/7px — narrowest at the bottom of the ladder and, because both boxes are
              // linear in the same zoom, incapable of inverting. The right inset is the two
              // corner marks' own 4px, so the column stands in the same gutter they do.
              "top-[calc(1.5rem*var(--mark-scale,1))] right-[calc(0.25rem*var(--mark-scale,1))]",
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
